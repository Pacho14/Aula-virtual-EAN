import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import {
  Plane,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type Mesh,
  type MeshStandardMaterial,
} from "three";
import type { InputLayer } from "../input/inputLayer";
import { GESTURE_INDEX, type HandFrame } from "../input/types";
import { aimAt, type Scene } from "../net/api";
import type { AulaRoom } from "../net/room";
import type { Voice } from "../net/voice";
import { WidgetPointer } from "../ui3d/pointer";
import { exposeWidgetProbe, pointer } from "../ui3d/widgets";
import { snapToPlacement } from "./placement";
import { AUTO_GRAB_WINDOW_MS, autoGrab, grabbables, predicted } from "./registry";

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
/** Distancia a la que se dibuja la propia mano sobre el rayo. */
const HAND_DISTANCE = 0.55;

/**
 * La camara sigue a la mano.
 *
 * Con la mano cerca del centro del cuadro la vista no se mueve: una camara
 * que corrige siempre da la sensacion de que la escena flota. Solo cuando la
 * mano se acerca al borde -mas alla de la zona muerta- la vista la acompana,
 * y lo justo para que no se salga. Sin esto, alcanzar el panel de la
 * izquierda significa sacar la mano de cuadro y perder el puntero.
 */
const FOLLOW_DEADZONE = 0.42;
const FOLLOW_YAW_RATE = 1.25;
const FOLLOW_PITCH_RATE = 0.85;
/** Cuanto puede alejarse la vista de su orientacion de partida. */
const FOLLOW_YAW_LIMIT = 1.15;

const UP = new Vector3(0, 1, 0);

const ndc = new Vector2();
const raycaster = new Raycaster();
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
  hoveredRef,
  onHud,
}: {
  room: AulaRoom;
  sessionId: string;
  input: InputLayer;
  scene: Scene;
  voice: Voice | null;
  hoveredRef: React.RefObject<string | null>;
  onHud: (snapshot: HudSnapshot) => void;
}) {
  const { camera, gl } = useThree();

  const look = useRef({ yaw: 0, pitch: 0, rest: 0, dragging: false, lastX: 0, lastY: 0 });
  type Held = { id: string; half: [number, number, number] };
  const held = useRef<Held | null>(null);
  const pending = useRef<(Held & { at: number }) | null>(null);
  const timers = useRef({ pose: 0, hud: 0, frames: 0, fpsAt: 0, renderFps: 0 });
  /** Ultimo tamano de palma visto: proxy de profundidad para la propia mano. */
  const lastSpan = useRef(0.1);
  const cursorDistance = useRef(2.6);
  const cursorRef = useRef<Mesh>(null);
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
  const dwellRef = useRef<Mesh>(null);
  const leftHandRef = useRef<Mesh>(null);
  const rightHandRef = useRef<Mesh>(null);
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
    const aim = aimAt(spot.pos, scene.focus);
    look.current.yaw = aim.yaw;
    look.current.rest = aim.yaw;
    look.current.pitch = aim.pitch;
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
      look.current.yaw -= (event.clientX - look.current.lastX) * 0.004;
      look.current.pitch = clamp(
        look.current.pitch - (event.clientY - look.current.lastY) * 0.004,
        -1.1,
        1.1,
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
    const frame = input.tick(now);

    const primary = frame.primary;
    if (primary) lastSpan.current = primary.span;

    // La vista acompana a la mano para que nunca se salga de cuadro. Solo con
    // camara: con mouse, el puntero es el mouse y la vista no debe moverse
    // sola debajo de el.
    if (primary && frame.source === "camera" && !look.current.dragging) {
      const ex = beyond(primary.ndcX, FOLLOW_DEADZONE);
      const ey = beyond(primary.ndcY, FOLLOW_DEADZONE);
      if (ex !== 0) {
        look.current.yaw = clamp(
          look.current.yaw - ex * FOLLOW_YAW_RATE * delta,
          look.current.rest - FOLLOW_YAW_LIMIT,
          look.current.rest + FOLLOW_YAW_LIMIT,
        );
      }
      if (ey !== 0) {
        look.current.pitch = clamp(
          look.current.pitch + ey * FOLLOW_PITCH_RATE * delta,
          -1.0,
          1.0,
        );
      }
    }

    // Camara: fija en el punto asignado, con la orientacion que dejaron el
    // arrastre y el seguimiento de la mano. La matriz se recalcula aqui mismo
    // porque el rayo del puntero, unas lineas mas abajo, la usa en este cuadro
    // y no en el siguiente.
    camera.rotation.set(look.current.pitch, look.current.yaw, 0, "YXZ");
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
    if (primary) {
      ndc.set(primary.ndcX, primary.ndcY);
      raycaster.setFromCamera(ndc, camera);

      const gesture = primary.gesture;
      const carrying = Boolean(held.current || pending.current);

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
          raycaster,
          now,
          gesture === "fist" || gesture === "pinch",
          selectPulse.current,
        );
      }

      if (held.current) {
        hovered = held.current.id;
      } else if (!onWidget) {
        const hits = raycaster.intersectObjects([...grabbables.values()], false);
        const hit = hits[0];
        if (hit) {
          hovered = (hit.object.userData as { objectId?: string }).objectId ?? null;
          cursorDistance.current = hit.distance;
        }
      }
    } else {
      widgetPointer.current.reset();
    }
    selectPulse.current = false;
    hoveredRef.current = hovered;

    // Una pieza recien sacada del panel de objetos se toma sin soltar: elegir
    // el cubo y llevarlo a la mesa son un solo movimiento. Se reintenta unos
    // cuadros porque el aviso del servidor puede adelantarse al estado que
    // trae la pieza.
    if (autoGrab.id) {
      if (startGrab(autoGrab.id, false) || now - autoGrab.since > AUTO_GRAB_WINDOW_MS) {
        autoGrab.id = null;
      }
    }

    // Cursor: en el punto que toca el rayo, o flotando a media sala si no
    // toca nada. Sin un cursor visible no hay forma de apuntar con la mano.
    const cursor = cursorRef.current;
    if (cursor && primary) {
      cursor.visible = true;
      const distance = onWidget
        ? pointer.distance
        : hovered
          ? cursorDistance.current
          : 2.6;
      cursor.position
        .copy(raycaster.ray.origin)
        .addScaledVector(raycaster.ray.direction, distance);
      cursor.lookAt(camera.position);
      const scale = hovered || held.current || onWidget ? 0.055 : 0.032;
      cursor.scale.setScalar(scale + (held.current ? 0.02 : 0));
    } else if (cursor) {
      cursor.visible = false;
    }

    // El anillo que se llena alrededor del cursor es la espera sostenida: sin
    // el, nadie descubre que basta con dejar la mano quieta sobre un boton.
    const dwellRing = dwellRef.current;
    if (dwellRing) {
      const progress = onWidget ? pointer.dwell : 0;
      dwellRing.visible = progress > 0.02;
      if (dwellRing.visible && cursor) {
        dwellRing.position.copy(cursor.position);
        dwellRing.quaternion.copy(cursor.quaternion);
        dwellRing.scale.setScalar(cursor.scale.x * 1.5);
        // Un anillo de 24 tramos son 6 indices por tramo: recortar el rango
        // de dibujo pinta solo el arco recorrido, sin rehacer la geometria.
        dwellRing.geometry.setDrawRange(0, Math.round(progress * 24) * 6);
      }
    }

    // Las propias manos, para saber donde estan sin mirar el video. Solo con
    // camara: con mouse ya hay cursor del sistema, y una esfera a 55 cm de la
    // cara tapa media escena sin aportar nada.
    const showHands = frame.source === "camera";
    updateOwnHand(leftHandRef.current, showHands ? frame.left : null, handWorld.current.left);
    updateOwnHand(rightHandRef.current, showHands ? frame.right : null, handWorld.current.right);

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
      if (raycaster.ray.intersectPlane(surface, targetPos)) {
        got =
          Math.abs(targetPos.x - zone.table.center[0]) <= zone.table.half[0] + zone.reach &&
          Math.abs(targetPos.z - zone.table.center[1]) <= zone.table.half[1] + zone.reach;
      }
      if (!got) {
        surface.setFromNormalAndCoplanarPoint(UP, targetPos.set(0, half[1], 0));
        got = Boolean(raycaster.ray.intersectPlane(surface, targetPos));
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
      pose[3] = look.current.yaw + yawOffset;
      pose[4] = clamp(look.current.pitch + pitchOffset, -1.4, 1.4);

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

  return (
    <group>
      <mesh ref={cursorRef} visible={false} raycast={() => null}>
        <ringGeometry args={[0.6, 1, 24]} />
        <meshBasicMaterial color="#0B6E67" transparent opacity={0.85} depthTest={false} />
      </mesh>
      <mesh ref={dwellRef} visible={false} raycast={() => null}>
        <ringGeometry args={[1.15, 1.45, 24]} />
        <meshBasicMaterial color="#12938A" transparent opacity={0.95} depthTest={false} />
      </mesh>
      <mesh ref={leftHandRef} visible={false}>
        <sphereGeometry args={[0.045, 12, 10]} />
        <meshStandardMaterial color="#0B6E67" roughness={0.5} />
      </mesh>
      <mesh ref={rightHandRef} visible={false}>
        <sphereGeometry args={[0.045, 12, 10]} />
        <meshStandardMaterial color="#0B6E67" roughness={0.5} />
      </mesh>
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

function updateOwnHand(mesh: Mesh | null, hand: HandFrame | null, world: Vector3) {
  if (!mesh) return;
  if (!hand) {
    mesh.visible = false;
    return;
  }
  mesh.visible = true;
  mesh.position.lerp(world, 0.5);
  const material = mesh.material as MeshStandardMaterial;
  material.color.set(HAND_COLORS[hand.gesture] ?? HAND_COLORS.none!);
  // El puno se dibuja un poco mas pequeno, como una mano cerrada.
  const scale = hand.gesture === "fist" ? 0.8 : 1;
  mesh.scale.setScalar(scale);
}

function projectHand(hand: HandFrame, camera: Camera, out: Vector3) {
  ndc.set(hand.ndcX, hand.ndcY);
  raycaster.setFromCamera(ndc, camera);
  out
    .copy(raycaster.ray.origin)
    .addScaledVector(raycaster.ray.direction, HAND_DISTANCE);
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

/** Cuanto se pasa un valor de la zona muerta, con su signo. Cero dentro. */
function beyond(value: number, deadzone: number) {
  if (value > deadzone) return value - deadzone;
  if (value < -deadzone) return value + deadzone;
  return 0;
}
