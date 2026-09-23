import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import {
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
import { grabbables, predicted } from "./registry";

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

const ndc = new Vector2();
const raycaster = new Raycaster();
const targetPos = new Vector3();
const forward = new Vector3();
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

  const look = useRef({ yaw: 0, pitch: 0, dragging: false, lastX: 0, lastY: 0 });
  const held = useRef<{ id: string; distance: number; span: number } | null>(null);
  const pending = useRef<{ id: string; distance: number; span: number; at: number } | null>(null);
  const timers = useRef({ pose: 0, hud: 0, frames: 0, fpsAt: 0, renderFps: 0 });
  /** Ultimo tamano de palma visto: fija la profundidad al momento de agarrar. */
  const lastSpan = useRef(0.1);
  const cursorDistance = useRef(2.6);
  const cursorRef = useRef<Mesh>(null);
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
    look.current.pitch = aim.pitch;
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
  useEffect(() => {
    return input.on((action) => {
      if (action === "grab") {
        const id = hoveredRef.current;
        if (!id || held.current) return;
        const object = room.state.objects.get(id);
        if (!object || object.heldBy !== "") return;
        const distance = camera.position.distanceTo(
          new Vector3(object.x, object.y, object.z),
        );
        const span = lastSpan.current || 0.1;
        pending.current = { id, distance, span, at: performance.now() };
        room.send("grab", { id });
      }

      if (action === "release") {
        const current = held.current ?? pending.current;
        if (!current) return;
        room.send("release", { id: current.id });
        predicted.delete(current.id);
        held.current = null;
        pending.current = null;
      }

      if (action === "raiseHand") room.send("raiseHand", { v: true });
      if (action === "lowerHand") room.send("raiseHand", { v: false });
    });
  }, [camera, hoveredRef, input, room]);

  useFrame((_, delta) => {
    const now = performance.now();
    const frame = input.tick(now);

    // Camara: fija en el punto asignado, con la orientacion del arrastre.
    camera.rotation.set(look.current.pitch, look.current.yaw, 0, "YXZ");

    const primary = frame.primary;
    if (primary) lastSpan.current = primary.span;

    // Posicion mundial de cada mano sobre su propio rayo.
    handWorld.current.leftTracked = Boolean(frame.left);
    handWorld.current.rightTracked = Boolean(frame.right);
    if (frame.left) projectHand(frame.left, camera, handWorld.current.left);
    if (frame.right) projectHand(frame.right, camera, handWorld.current.right);

    // Rayo del puntero.
    let hovered: string | null = null;
    if (primary) {
      ndc.set(primary.ndcX, primary.ndcY);
      raycaster.setFromCamera(ndc, camera);

      if (!held.current) {
        const hits = raycaster.intersectObjects([...grabbables.values()], false);
        const hit = hits[0];
        if (hit) {
          hovered = (hit.object.userData as { objectId?: string }).objectId ?? null;
          cursorDistance.current = hit.distance;
        }
      } else {
        hovered = held.current.id;
      }
    }
    hoveredRef.current = hovered;

    // Cursor: en el punto que toca el rayo, o flotando a media sala si no
    // toca nada. Sin un cursor visible no hay forma de apuntar con la mano.
    const cursor = cursorRef.current;
    if (cursor && primary) {
      cursor.visible = true;
      const distance = hovered ? cursorDistance.current : 2.6;
      cursor.position
        .copy(raycaster.ray.origin)
        .addScaledVector(raycaster.ray.direction, distance);
      cursor.lookAt(camera.position);
      const scale = hovered || held.current ? 0.055 : 0.032;
      cursor.scale.setScalar(scale + (held.current ? 0.02 : 0));
    } else if (cursor) {
      cursor.visible = false;
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
        held.current = {
          id: pending.current.id,
          distance: pending.current.distance,
          span: pending.current.span,
        };
        pending.current = null;
      } else if (now - pending.current.at > 1000) {
        pending.current = null;
      }
    }

    // Arrastre del objeto agarrado.
    if (held.current && primary) {
      // Acercar y alejar con la profundidad de la mano: la palma crece al
      // acercarse a la camara. El recorte evita que un mal cuadro lance el
      // objeto al otro lado de la sala.
      const ratio = clamp(held.current.span / Math.max(primary.span, 1e-4), 0.6, 1.7);
      const distance = clamp(held.current.distance * ratio, 0.45, 4.5);
      targetPos
        .copy(raycaster.ray.origin)
        .addScaledVector(raycaster.ray.direction, distance);
      targetPos.y = Math.max(targetPos.y, 0.05);

      let slot = predicted.get(held.current.id);
      if (!slot) {
        slot = targetPos.clone();
        predicted.set(held.current.id, slot);
      }
      slot.lerp(targetPos, 1 - Math.exp(-18 * delta));
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
      <mesh ref={cursorRef} visible={false}>
        <ringGeometry args={[0.6, 1, 24]} />
        <meshBasicMaterial color="#0B6E67" transparent opacity={0.85} depthTest={false} />
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
