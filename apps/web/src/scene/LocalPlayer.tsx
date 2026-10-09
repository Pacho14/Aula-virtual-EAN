import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import { Plane, Vector2, Vector3 } from "three";
import type { InputLayer } from "../input/inputLayer";
import { GESTURE_INDEX, HOLD_GESTURES, type HandFrame } from "../input/types";
import { aimAt, type Scene } from "../net/api";
import type { AulaRoom } from "../net/room";
import type { Voice } from "../net/voice";
import { cursorState, handRay, HandCursor } from "../ui3d/HandCursor";
import { DWELL_MS, WidgetPointer } from "../ui3d/pointer";
import { exposeWidgetProbe, pointer } from "../ui3d/widgets";
import { cameraRig, nudgeRig, restRig } from "./cameraRig";
import { OwnHands, type OwnHandsHandle } from "./OwnHands";
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

/**
 * Cuanto tiene que llevar una pieza en la mano antes de poder soltarla.
 *
 * Es la unica excepcion a "abrir la mano suelta", y existe porque **tomar y
 * soltar pueden caer en el mismo gesto**:
 *
 * - Con mouse, un click es apretar y soltar casi a la vez. La pieza sale del
 *   panel al apretar y el soltar inmediato la dejaria caer ahi mismo.
 * - Con la mano, el detector puede perder el pellizco un cuadro justo despues
 *   de tomar algo, y la pieza se caeria sola.
 *
 * Los dos casos son el mismo: un soltar que no es una decision, sino el final
 * del gesto con el que se tomo. 300 ms no le quitan nada a quien si quiere
 * soltar -nadie toma y deja algo mas rapido que eso- y hacen que con mouse la
 * cosa funcione sola como click para tomar y click para soltar, sin una sola
 * linea que pregunte de que dispositivo venimos.
 */
const SETTLE_MS = 300;

const UP = new Vector3(0, 1, 0);

const ndc = new Vector2();
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
  /** Cuando empezo el agarre que esta en curso. Ver `SETTLE_MS`. */
  const grabbedAt = useRef(0);
  /** Que pieza se esta esperando y desde cuando. El contador. */
  const objectDwell = useRef<{ id: string | null; since: number }>({ id: null, since: 0 });
  /** La mano venia cerrada del cuadro anterior, para tomar en el flanco. */
  const cerradaAntes = useRef(false);
  /** A que distancia corto el rayo la pieza: donde va el contador. */
  const hitDistance = useRef(2.6);
  const handsRef = useRef<OwnHandsHandle>(null);
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
   * No hace falta decirle como se tomo: se suelta siempre igual, abriendo la
   * mano.
   */
  const startGrab = useCallback(
    (id: string) => {
      if (held.current || pending.current) return false;
      const object = room.state.objects.get(id);
      if (!object || object.heldBy !== "") return false;
      pending.current = {
        id,
        half: [object.sx / 2, object.sy / 2, object.sz / 2],
        at: performance.now(),
      };
      grabbedAt.current = performance.now();
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
      // **Abrir la mano suelta.** Es lo unico que llega como accion: tomar lo
      // resuelve cada control a su manera, porque no todos se toman igual.
      //
      // La excepcion es una pieza recien tomada: ver `SETTLE_MS`.
      if (action === "release" && performance.now() - grabbedAt.current >= SETTLE_MS) drop();

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

    // Las propias manos, con el mismo modulo que usa el lobby.
    //
    // **Se dibujan siempre que haya camara**, tambien mientras el profesor
    // arma el salon. Antes ahi se escondian, con el argumento de que la
    // pantalla es casi toda paneles y la mano los tapa; el argumento era malo,
    // porque es justo la pantalla donde mas se usan -se pulsa, se arrastra y
    // se sacan piezas- y esconder la mano deja sin saber si el detector la ve.
    // Si tapan algo, lo que hay que mover son los paneles.
    const carryingNow = Boolean(held.current || pending.current);
    const showHands = frame.source === "camera";
    handWorld.current.leftTracked = Boolean(frame.left);
    handWorld.current.rightTracked = Boolean(frame.right);
    const placed = handsRef.current?.update(frame.left, frame.right, camera, {
      carrying: carryingNow,
      draw: showHands,
    });
    if (placed) {
      handWorld.current.left.copy(placed.left);
      handWorld.current.right.copy(placed.right);
    }

    // Rayo del puntero. La interfaz va primero: un panel esta delante de la
    // escena y tiene que ganarle al objeto que quede detras.
    let hovered: string | null = null;
    let onWidget = false;
    /** Avance del contador sobre una pieza, de 0 a 1. */
    let dwell = 0;
    if (primary) {
      const gesture = primary.gesture;
      const carrying = Boolean(held.current || pending.current);

      // **De donde sale el rayo depende de si se lleva algo.**
      //
      // Con la mano libre, de la punta del indice: señalar con el dedo es el
      // gesto que la gente hace sola, y es con lo que se apunta en el lobby,
      // en los paneles y en los rieles.
      //
      // Con una pieza en la mano, del centro de la palma. La punta del indice
      // **se desploma hacia la palma al abrir y cerrar la mano**, asi que con
      // ella mandando, el gesto de soltar mueve la pieza en el mismo instante
      // de soltarla: se suelta y aterriza en otro sitio del que se apuntaba.
      // La palma no se desplaza con los dedos, asi que abrir la mano suelta la
      // pieza donde estaba y nada mas.
      //
      // El cambio no se nota porque pasa cuando la pieza ya esta tomada: en
      // ese momento lo que se sigue con la vista es la pieza, no el cursor.
      if (carrying) ndc.set(primary.ndcX, primary.ndcY);
      else ndc.set(primary.indexNdcX, primary.indexNdcY);
      handRay.setFromCamera(ndc, camera);

      // Cerrar la mano, y si acaba de cerrarse. Lo segundo solo lo usa el
      // mouse para tomar una pieza en el click; con camara manda el contador.
      const cerrandoAhora = HOLD_GESTURES.has(gesture);

      // Arrastrando un deslizador de la pantalla, la escena no escucha: el
      // mismo pellizco no puede mover la camara y pulsar un boton a la vez.
      if (cameraRig.handBusy) {
        cerradaAntes.current = cerrandoAhora;
        widgetPointer.current.reset();
        hoveredRef.current = null;
        cursorState.visible = false;
        return;
      }

      // Con una pieza en la mano la interfaz no escucha: cruzar por delante
      // de un panel camino de la mesa no puede pulsar nada.
      if (carrying) {
        // Con una pieza en la mano la interfaz no escucha. Soltarla no se
        // decide aqui: lo hace la accion `release` en cuanto la mano se abre.
        widgetPointer.current.reset();
      } else {
        onWidget = widgetPointer.current.update(
          handRay,
          now,
          cerrandoAhora,
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

      // **El contador.** Apuntas a una pieza, sostienes la mano, el anillo se
      // llena y la pieza es tuya. Se suelta abriendo la mano.
      //
      // Es la unica cosa que se toma asi, y por eso: una pieza esta lejos, se
      // apunta, y lo que conviene ahi es que **no haga falta que se lea ningun
      // gesto** mientras se apunta -que es justo lo que peor funciona cuando
      // el detector va a cinco cuadros por segundo. Un boton es lo contrario:
      // es una orden de una sola vez, cerrar la mano es instantaneo, y un
      // codigo de seis digitos a 850 ms por tecla serian cinco segundos.
      //
      // Con mouse no hay contador: el click ya es deliberado y esperar encima
      // de una pieza con el cursor seria una espera sin motivo.
      const libre = Boolean(hovered) && !held.current && !pending.current && !onWidget;
      if (libre && frame.source === "camera") {
        if (objectDwell.current.id !== hovered) {
          objectDwell.current.id = hovered;
          objectDwell.current.since = now;
        }
        dwell = Math.min(1, (now - objectDwell.current.since) / DWELL_MS);
        if (dwell >= 1) {
          startGrab(hovered!);
          objectDwell.current.id = null;
          dwell = 0;
        }
      } else {
        objectDwell.current.id = null;
        if (libre && cerrandoAhora && !cerradaAntes.current) startGrab(hovered!);
      }
      cerradaAntes.current = cerrandoAhora;

    } else {
      widgetPointer.current.reset();
      objectDwell.current.id = null;
      cerradaAntes.current = false;
    }
    hoveredRef.current = hovered;

    // **La mano y el cursor se ven los dos, siempre.**
    //
    // Antes se escondia uno de los dos para que no hubiera "dos punteros", y
    // la regla sobraba: los dos caen sobre el **mismo rayo** -la mano se ancla
    // al reves, poniendo primero el punto con el que se apunta- asi que en
    // pantalla quedan alineados. La mano, a medio metro; el cursor, alla donde
    // el rayo toca. No compiten: dicen lo mismo a dos distancias, que es
    // exactamente lo que hace falta para apuntar a algo lejano con una mano
    // que esta cerca.
    // El anillo del cursor sirve a los dos contadores: el de las piezas, que
    // lleva esta funcion, y el de los controles, que lleva `WidgetPointer`.
    cursorState.dwell = onWidget ? pointer.dwell : dwell;
    cursorState.visible = true;
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
      if (startGrab(autoGrab.id) || now - autoGrab.since > AUTO_GRAB_WINDOW_MS) {
        autoGrab.id = null;
      }
    }

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
      <OwnHands ref={handsRef} />
      <HandCursor />
    </group>
  );
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
