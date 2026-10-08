import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import { Plane, Vector2, Vector3, type Camera } from "three";
import { INDEX_TIP, jointInViewSpace, viewDepth, type Vec3 } from "../input/handSpace";
import type { InputLayer } from "../input/inputLayer";
import { GESTURE_INDEX, type HandFrame } from "../input/types";
import { aimAt, type Scene } from "../net/api";
import type { AulaRoom } from "../net/room";
import type { Voice } from "../net/voice";
import { cursorState, handRay, HandCursor } from "../ui3d/HandCursor";
import { DWELL_MS, WidgetPointer } from "../ui3d/pointer";
import { exposeWidgetProbe, pointer } from "../ui3d/widgets";
import { cameraRig, nudgeRig, restRig } from "./cameraRig";
import { HandSkeleton, type HandSkeletonHandle } from "./HandSkeleton";
import { snapToPlacement } from "./placement";
import { AUTO_GRAB_WINDOW_MS, autoGrab, grabbables, grabbablesList, predicted } from "./registry";

export interface HudSnapshot {
  gesture: string;
  detectFps: number;
  renderFps: number;
  hovered: string | null;
  held: string | null;
  handRaised: boolean;
  source: "camera" | "mouse";
}

/** El cliente envia pose 20 veces por segundo, como fija la seccion 05. */
const POSE_INTERVAL_MS = 50;

const UP = new Vector3(0, 1, 0);

const ndc = new Vector2();
/** Cuanto separa la punta del indice de la muñeca. Ver `projectHand`. */
const tipOffset: Vec3 = [0, 0, 0];
const tipWorld = new Vector3();
const targetPos = new Vector3();
const forward = new Vector3();
const surface = new Plane();
const pose = new Array<number>(15).fill(0);

export function LocalPlayer({
  room,
  sessionId,
  input,
  scene,
  voice,
  editing,
  hoveredRef,
  onHud,
}: {
  room: AulaRoom;
  sessionId: string;
  input: InputLayer;
  scene: Scene;
  voice: Voice | null;
  /** El profesor armando el salon, antes de que entre nadie. */
  editing: boolean;
  hoveredRef: React.RefObject<string | null>;
  onHud: (snapshot: HudSnapshot) => void;
}) {
  const { camera, gl } = useThree();

  /**
   * El arrastre con mouse no lleva su propio angulo: escribe en el mismo sitio
   * que los deslizadores de pantalla, asi que arrastrar mueve el deslizador y
   * mover el deslizador mueve la vista. Un solo valor, dos maneras de tocarlo.
   */
  const look = useRef({ dragging: false, lastX: 0, lastY: 0 });
  type Held = { id: string; half: [number, number, number] };
  const held = useRef<Held | null>(null);
  const pending = useRef<(Held & { at: number }) | null>(null);
  const timers = useRef({ pose: 0, hud: 0, frames: 0, fpsAt: 0, renderFps: 0 });
  const widgetPointer = useRef(new WidgetPointer());
  /** Un pellizco vale por un cuadro: es un flanco, no un estado. */
  const selectPulse = useRef(false);
  /**
   * Si abrir la mano ya puede soltar la pieza que se tiene.
   *
   * Lo arma cerrar el puno, y nada mas. Una pieza recien sacada del panel
   * llega a una mano que sigue abierta: si abrir bastara, se caeria en el
   * sitio en el mismo instante de aparecer. Para esa pieza queda el pellizco,
   * que es un gesto deliberado, o cerrar la mano y volver a abrirla.
   */
  const armed = useRef(false);
  /** A que distancia corto el rayo la pieza: donde va el contador. */
  const hitDistance = useRef(2.6);
  /** Que pieza se esta esperando y desde cuando. */
  const objectDwell = useRef<{ id: string | null; since: number }>({ id: null, since: 0 });
  const leftHandRef = useRef<HandSkeletonHandle>(null);
  const rightHandRef = useRef<HandSkeletonHandle>(null);
  /**
   * Donde esta cada mano en la escena. Sirve para dos cosas: dibujar la
   * propia mano, y viajar en la pose -de aqui salen las manos del avatar que
   * ven los demas participantes.
   */
  const handWorld = useRef({
    left: new Vector3(),
    right: new Vector3(),
    leftTracked: false,
    rightTracked: false,
  });

  // --- ubicacion en el punto asignado -------------------------------------
  useEffect(() => {
    const me = room.state.players.get(sessionId);
    const spot = scene.spots.find((s) => s.id === me?.spotId) ?? scene.spots[0]!;
    camera.position.set(spot.pos[0], 1.6, spot.pos[2]);
    // Mirando a la mesa de trabajo. Al centro geometrico de la sala queda
    // apuntando un metro por encima de donde pasa algo.
    // La orientacion de partida mira a la mesa; los deslizadores se mueven
    // respecto de ella, asi que su cero es "de frente al trabajo".
    const aim = aimAt(spot.pos, scene.focus);
    restRig(aim.yaw, aim.pitch);
    exposeWidgetProbe(camera, grabbables);
  }, [camera, room, scene, sessionId]);

  // --- mirar alrededor arrastrando ----------------------------------------
  useEffect(() => {
    const element = gl.domElement;

    const down = (event: PointerEvent) => {
      // Con la camara como entrada, el mouse queda libre para mirar. Con el
      // mouse como entrada, el mouse ES el puntero y no debe girar la vista.
      if (input.kind !== "camera") return;
      look.current.dragging = true;
      look.current.lastX = event.clientX;
      look.current.lastY = event.clientY;
    };
    const move = (event: PointerEvent) => {
      if (!look.current.dragging) return;
      nudgeRig(
        -(event.clientX - look.current.lastX) * 0.004,
        -(event.clientY - look.current.lastY) * 0.004,
      );
      look.current.lastX = event.clientX;
      look.current.lastY = event.clientY;
    };
    const up = () => {
      look.current.dragging = false;
    };

    element.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      element.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [gl, input]);

  // --- acciones de la capa de entrada -------------------------------------
  /**
   * Devuelve si de verdad empezo el agarre.
   *
   * `conElPuno` distingue las dos formas de acabar con una pieza en la mano, y
   * de ahi sale si abrirla ya la suelta. Quien cierra el puno sobre una pieza
   * la suelta al abrirlo, como siempre. Quien la saca del panel no ha cerrado
   * nada: su mano ya estaba abierta -o pellizcando el boton- y soltarla ahi
   * dejaria la pieza en el aire en el instante de aparecer.
   */
  const startGrab = useCallback(
    (id: string, conElPuno: boolean) => {
      if (held.current || pending.current) return false;
      const object = room.state.objects.get(id);
      if (!object || object.heldBy !== "") return false;
      pending.current = {
        id,
        half: [object.sx / 2, object.sy / 2, object.sz / 2],
        at: performance.now(),
      };
      armed.current = conElPuno;
      room.send("grab", { id });
      return true;
    },
    [room],
  );

  const drop = useCallback(() => {
    const current = held.current ?? pending.current;
    if (!current) return;
    room.send("release", { id: current.id });
    predicted.delete(current.id);
    held.current = null;
    pending.current = null;
  }, [room]);

  useEffect(() => {
    return input.on((action) => {
      // Sobre un control de la interfaz, el pellizco lo pulsa; con una pieza
      // en la mano, la suelta. El puntero decide cual de las dos cosas es.
      if (action === "select") {
        if (held.current || pending.current) drop();
        else selectPulse.current = true;
      }

      if (action === "grab") {
        // Cerrar el puno sobre un boton no puede, ademas, llevarse una pieza.
        if (pointer.hoveredId) return;
        const id = hoveredRef.current;
        if (id) startGrab(id, true);
      }

      // Abrir la mano suelta lo que se cerro el puno para tomar. Lo que vino
      // del panel no: ver `armed`.
      if (action === "release" && armed.current) drop();

      if (action === "raiseHand") room.send("raiseHand", { v: true });
      if (action === "lowerHand") room.send("raiseHand", { v: false });
    });
  }, [drop, hoveredRef, input, room, startGrab]);

  useFrame((_, delta) => {
    const now = performance.now();
    // Antes de leer el cuadro, porque de aqui sale si "mano abierta" se puede
    // leer como pedir la palabra o es solo soltar lo que se lleva.
    input.setCarrying(Boolean(held.current || pending.current));
    const frame = input.tick(now);

    const primary = frame.primary;

    // La camara no se desplaza nunca: se queda en el punto asignado y solo
    // cambia hacia donde mira, y eso lo deciden los deslizadores de pantalla.
    // La matriz se recalcula aqui mismo porque el rayo del puntero, unas
    // lineas mas abajo, la usa en este cuadro y no en el siguiente.
    camera.rotation.set(
      cameraRig.restPitch + cameraRig.pitch,
      cameraRig.restYaw + cameraRig.yaw,
      0,
      "YXZ",
    );
    camera.updateMatrixWorld();

    // Posicion mundial de cada mano sobre su propio rayo.
    handWorld.current.leftTracked = Boolean(frame.left);
    handWorld.current.rightTracked = Boolean(frame.right);
    if (frame.left) projectHand(frame.left, camera, handWorld.current.left);
    if (frame.right) projectHand(frame.right, camera, handWorld.current.right);

    // Rayo del puntero. La interfaz va primero: un panel esta delante de la
    // escena y tiene que ganarle al objeto que quede detras.
    let hovered: string | null = null;
    let onWidget = false;
    /** Avance del contador de la espera sostenida, de 0 a 1. */
    let dwell = 0;
    if (primary) {
      // La punta del indice, exactamente igual que en el lobby (ver
      // LobbyPointer). Señalar con el dedo es el gesto que la gente hace
      // sola, y el lobby lleva tiempo demostrando que asi se apunta bien.
      //
      // La razon por la que aqui se usaba la palma -que la punta se desploma
      // al cerrar la mano y la pieza saltaria al agarrarla- es real, pero se
      // paga en todo lo demas: se apunta peor todo el rato para que un
      // instante concreto salga limpio. Si el salto al agarrar molesta, se
      // arregla ahi y no cambiando como se apunta.
      ndc.set(primary.indexNdcX, primary.indexNdcY);
      handRay.setFromCamera(ndc, camera);

      const gesture = primary.gesture;
      const carrying = Boolean(held.current || pending.current);

      // Arrastrando un deslizador de la pantalla, la escena no escucha: el
      // mismo pellizco no puede mover la camara y pulsar un boton a la vez.
      if (cameraRig.handBusy) {
        widgetPointer.current.reset();
        selectPulse.current = false;
        hoveredRef.current = null;
        // Esto sale de la funcion antes de llegar al bloque del contador, asi
        // que hay que apagarlo aqui o se queda pintado a medio llenar
        // mientras se mueve la camara.
        objectDwell.current.id = null;
        cursorState.dwell = 0;
        cursorState.visible = false;
        return;
      }

      // Con una pieza en la mano la interfaz no escucha: cruzar por delante
      // de un panel camino de la mesa no puede pulsar nada.
      if (carrying) {
        widgetPointer.current.reset();
        // Cerrar el puno sobre una pieza que vino del panel arma el soltado:
        // de ahi en adelante se suelta como cualquier otra.
        if (gesture === "fist") armed.current = true;
        else if (gesture === "open" && armed.current) drop();
      } else {
        onWidget = widgetPointer.current.update(
          handRay,
          now,
          gesture === "fist" || gesture === "pinch",
          selectPulse.current,
          frame.source === "camera",
        );
      }

      if (held.current) {
        hovered = held.current.id;
      } else if (!onWidget) {
        const hits = handRay.intersectObjects(grabbablesList, false);
        const hit = hits[0];
        if (hit) {
          hovered = (hit.object.userData as { objectId?: string }).objectId ?? null;
          hitDistance.current = hit.distance;
        }
      }

      // Espera sostenida sobre una pieza: apuntarla y quedarse quieto la
      // toma, sin ningun gesto. Los botones ya se pulsaban asi; las piezas
      // solo se podian agarrar cerrando el puño, y un gesto es justo lo que
      // peor se lee cuando el detector va a cinco cuadros por segundo.
      //
      // Solo con camara: con mouse hay click, y ahi quedarse quieto encima de
      // una pieza no puede llevarsela.
      const puedeEsperar =
        frame.source === "camera" && Boolean(hovered) && !held.current && !pending.current;
      if (puedeEsperar) {
        if (objectDwell.current.id !== hovered) {
          objectDwell.current.id = hovered;
          objectDwell.current.since = now;
        }
        dwell = Math.min(1, (now - objectDwell.current.since) / DWELL_MS);
        if (dwell >= 1) {
          // `false`: no se tomo cerrando el puño, asi que abrir la mano no la
          // suelta -se caeria en el aire nada mas tomarla, porque la mano que
          // apunta ya esta abierta. Se suelta pellizcando, o cerrando el puño
          // y abriendolo, igual que una pieza sacada del panel.
          startGrab(hovered!, false);
          objectDwell.current.id = null;
          dwell = 0;
        }
      } else {
        objectDwell.current.id = null;
      }
    } else {
      widgetPointer.current.reset();
      objectDwell.current.id = null;
    }
    selectPulse.current = false;
    hoveredRef.current = hovered;

    // Siempre hay **exactamente un** puntero a la vista, nunca dos y nunca
    // ninguno:
    //
    //   - Con la mano dibujada, la mano ES el puntero. El cursor solo asoma
    //     mientras corre el contador, porque ahi si hace falta ver donde se
    //     esta llenando el anillo.
    //   - Sin la mano dibujada -el profesor armando el salon, o el modo
    //     mouse-, el cursor se ve siempre. Sin esto no quedaba forma alguna
    //     de saber a que se apunta, que es justo lo que pasaba al esconder la
    //     mano en el editor.
    //
    // El contador en si va igual en los dos casos: sobre un boton o un
    // deslizador lo lleva el puntero de la interfaz, sobre una pieza el de
    // aqui arriba.
    const showHands = frame.source === "camera" && !editing;
    if (onWidget) dwell = pointer.dwell;
    cursorState.dwell = dwell;
    cursorState.visible = !showHands || dwell > 0.02;
    cursorState.big = Boolean(hovered || held.current || onWidget);
    cursorState.distance = onWidget
      ? pointer.distance
      : hovered
        ? hitDistance.current
        : 2.6;

    // Una pieza recien sacada del panel de objetos se toma sin soltar: elegir
    // el cubo y llevarlo a la mesa son un solo movimiento. Se reintenta unos
    // cuadros porque el aviso del servidor puede adelantarse al estado que
    // trae la pieza.
    if (autoGrab.id) {
      if (startGrab(autoGrab.id, false) || now - autoGrab.since > AUTO_GRAB_WINDOW_MS) {
        autoGrab.id = null;
      }
    }

    // La propia mano. Con mouse no hay ninguna que dibujar, y mientras el
    // profesor arma el salon tampoco: ahi la pantalla es casi toda paneles y
    // la mano los tapa, asi que manda el cursor -ver arriba- y la mano vuelve
    // al empezar la clase.
    updateOwnHand(leftHandRef.current, showHands ? frame.left : null, handWorld.current.left, camera);
    updateOwnHand(rightHandRef.current, showHands ? frame.right : null, handWorld.current.right, camera);

    // Confirmacion del agarre: el servidor es quien lo concede.
    if (pending.current) {
      const object = room.state.objects.get(pending.current.id);
      if (object?.heldBy === sessionId) {
        held.current = { id: pending.current.id, half: pending.current.half };
        pending.current = null;
      } else if (now - pending.current.at > 1000) {
        pending.current = null;
      }
    }

    // Arrastre del objeto agarrado.
    //
    // La pieza va a donde el rayo corta la superficie, no a una distancia
    // deducida del tamano de la palma. Juzgar profundidad con la camara es lo
    // mas impreciso que hay, y en una mesa no hace falta: se apunta al
    // tablero y la pieza cae ahi. Fuera del tablero, al piso.
    if (held.current && primary) {
      const zone = scene.placement;
      const half = held.current.half;
      let got = false;

      surface.setFromNormalAndCoplanarPoint(UP, targetPos.set(0, zone.table.top + half[1], 0));
      if (handRay.ray.intersectPlane(surface, targetPos)) {
        got =
          Math.abs(targetPos.x - zone.table.center[0]) <= zone.table.half[0] + zone.reach &&
          Math.abs(targetPos.z - zone.table.center[1]) <= zone.table.half[1] + zone.reach;
      }
      if (!got) {
        surface.setFromNormalAndCoplanarPoint(UP, targetPos.set(0, half[1], 0));
        got = Boolean(handRay.ray.intersectPlane(surface, targetPos));
      }

      if (got) {
        // El mismo iman que aplica el servidor. Si aqui se predijera otra
        // cosa, la pieza saltaria justo al soltarla.
        const placed = snapToPlacement(zone, targetPos.x, targetPos.z, half);
        targetPos.set(placed.x, placed.y, placed.z);

        let slot = predicted.get(held.current.id);
        if (!slot) {
          slot = targetPos.clone();
          predicted.set(held.current.id, slot);
        }
        slot.lerp(targetPos, 1 - Math.exp(-22 * delta));
      }
    } else if (held.current) {
      // Se perdio la mano con el objeto en el aire: soltarlo.
      room.send("release", { id: held.current.id });
      predicted.delete(held.current.id);
      held.current = null;
    }

    // --- envio de pose, 20 Hz ---------------------------------------------
    if (now - timers.current.pose >= POSE_INTERVAL_MS) {
      timers.current.pose = now;

      // La cabeza se inclina un poco hacia donde apunta la mano: el avatar
      // deja de verse congelado sin costar un rastreador de rostro.
      const yawOffset = primary ? primary.ndcX * 0.22 : 0;
      const pitchOffset = primary ? -primary.ndcY * 0.12 : 0;

      pose[0] = camera.position.x;
      pose[1] = camera.position.y;
      pose[2] = camera.position.z;
      pose[3] = cameraRig.restYaw + cameraRig.yaw + yawOffset;
      pose[4] = clamp(cameraRig.restPitch + cameraRig.pitch + pitchOffset, -1.4, 1.4);

      writeHand(pose, 5, frame.left, handWorld.current.left, handWorld.current.leftTracked);
      writeHand(pose, 10, frame.right, handWorld.current.right, handWorld.current.rightTracked);

      room.send("pose", pose);

      if (held.current) {
        const slot = predicted.get(held.current.id);
        if (slot) room.send("move", { id: held.current.id, p: [slot.x, slot.y, slot.z] });
      }
    }

    // --- oyente del audio espacial ----------------------------------------
    if (voice?.connected) {
      camera.getWorldDirection(forward);
      voice.setListener(
        camera.position.x,
        camera.position.y,
        camera.position.z,
        forward.x,
        forward.y,
        forward.z,
      );
    }

    // --- HUD: 5 veces por segundo, no 60 ----------------------------------
    timers.current.frames += 1;
    if (now - timers.current.fpsAt >= 1000) {
      timers.current.renderFps = timers.current.frames;
      timers.current.frames = 0;
      timers.current.fpsAt = now;
    }
    if (now - timers.current.hud >= 200) {
      timers.current.hud = now;
      onHud({
        gesture: primary?.gesture ?? "none",
        detectFps: frame.detectFps,
        renderFps: timers.current.renderFps,
        hovered,
        held: held.current?.id ?? null,
        handRaised: room.state.players.get(sessionId)?.handRaised ?? false,
        source: frame.source,
      });
    }
  });

  // La propia mano hace de puntero, asi que no hay cursor permanente: el
  // cursor era una segunda marca que decia lo mismo y nunca caia en el mismo
  // sitio. `HandCursor` sigue montado, pero solo se enciende mientras el
  // contador corre, y se posa sobre lo que se este esperando.
  return (
    <group>
      <HandSkeleton ref={leftHandRef} />
      <HandSkeleton ref={rightHandRef} />
      <HandCursor />
    </group>
  );
}

/** Color de la mano propia segun el gesto: realimentacion inmediata. */
const HAND_COLORS: Record<string, string> = {
  none: "#8FA2A0",
  point: "#0B6E67",
  pinch: "#12938A",
  fist: "#B4531A",
  open: "#5C7A1E",
};

function updateOwnHand(
  skeleton: HandSkeletonHandle | null,
  hand: HandFrame | null,
  world: Vector3,
  camera: Camera,
) {
  if (!skeleton) return;
  const color = hand ? (HAND_COLORS[hand.gesture] ?? HAND_COLORS.none!) : HAND_COLORS.none!;
  skeleton.update(hand, world, camera, color);
}

/**
 * Donde va la propia mano dentro de la escena.
 *
 * Sin cursor, la mano es la unica marca de hacia donde se apunta, asi que el
 * rayo tiene que pasar **por la mano dibujada** o se apuntaria a un sitio y
 * se seleccionaria otro. Y tiene que pasar por la punta del indice, que es
 * con lo que la gente señala.
 *
 * Eso no sale solo. El rayo lleva la ganancia de cameraSource.ts -para que un
 * movimiento corto alcance toda la pantalla- mientras que la forma de la mano
 * va en metros reales, sin amplificar. Asi que se coloca al reves de lo
 * normal: primero se calcula donde tiene que caer la punta del indice, y
 * despues se retrocede lo que esa punta se separa de la muñeca, que es por
 * donde se ancla el grupo.
 *
 * De fondo la mano va a la profundidad que diga `viewDepth`. Estirar el brazo
 * hacia la pantalla acerca la mano a la webcam, que es alejarla de los
 * propios ojos, asi que la mano se adentra en la escena hacia la mesa;
 * recogerla la trae hacia la cara, donde se ve grande solo por perspectiva,
 * porque su tamaño en metros no cambia nunca.
 */
function projectHand(hand: HandFrame, camera: Camera, out: Vector3) {
  ndc.set(hand.indexNdcX, hand.indexNdcY);
  handRay.setFromCamera(ndc, camera);
  out
    .copy(handRay.ray.origin)
    .addScaledVector(handRay.ray.direction, viewDepth(hand.cameraDistance));

  if (!hand.worldLandmarks) return;
  jointInViewSpace(hand.worldLandmarks, INDEX_TIP, tipOffset);
  tipWorld.set(tipOffset[0], tipOffset[1], tipOffset[2]).applyQuaternion(camera.quaternion);
  out.sub(tipWorld);
}

function writeHand(
  target: number[],
  offset: number,
  hand: HandFrame | null,
  world: Vector3,
  tracked: boolean,
) {
  target[offset] = tracked ? 1 : 0;
  target[offset + 1] = hand ? GESTURE_INDEX[hand.gesture] : 0;
  target[offset + 2] = tracked ? world.x : 0;
  target[offset + 3] = tracked ? world.y : 0;
  target[offset + 4] = tracked ? world.z : 0;
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}
