import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import {
  CanvasTexture,
  LinearFilter,
  MathUtils,
  Vector3,
  type Group,
  type Mesh,
  type Sprite,
} from "three";
import type { AulaRoom } from "../net/room";

/**
 * Avatares de medio cuerpo: cabeza, antebrazos y nombre (seccion 06).
 *
 * No hay torso ni piernas. Una pierna que nadie rastrea se ve peor que una
 * pierna ausente, y el cuerpo completo exigiria IK que no aporta a la clase.
 * El codo se resuelve con IK analitica de dos huesos desde un hombro estimado
 * bajo la cabeza, con una pista que lo empuja hacia afuera y abajo.
 */

const UPPER_ARM = 0.28;
const FOREARM = 0.27;
const UP = new Vector3(0, 1, 0);

// Temporales a nivel de modulo: useFrame corre 60 veces por segundo por
// avatar y no debe reservar memoria.
const tmpDir = new Vector3();
const tmpHint = new Vector3();
const tmpShoulder = new Vector3();
const tmpElbow = new Vector3();
const tmpWrist = new Vector3();
const tmpHead = new Vector3();

export function Avatars({
  room,
  ids,
  sessionId,
  onHeadPosition,
}: {
  room: AulaRoom;
  ids: string[];
  sessionId: string;
  onHeadPosition?: (voiceId: string, x: number, y: number, z: number) => void;
}) {
  return (
    <group>
      {ids
        .filter((id) => id !== sessionId)
        .map((id) => (
          <Avatar key={id} id={id} room={room} onHeadPosition={onHeadPosition} />
        ))}
    </group>
  );
}

function Avatar({
  id,
  room,
  onHeadPosition,
}: {
  id: string;
  room: AulaRoom;
  onHeadPosition?: (voiceId: string, x: number, y: number, z: number) => void;
}) {
  const headRef = useRef<Group>(null);
  const plateRef = useRef<Sprite>(null);
  const ringRef = useRef<Mesh>(null);
  const leftUpper = useRef<Mesh>(null);
  const rightUpper = useRef<Mesh>(null);
  const leftArm = useRef<Mesh>(null);
  const rightArm = useRef<Mesh>(null);
  const leftHand = useRef<Mesh>(null);
  const rightHand = useRef<Mesh>(null);

  const player = room.state.players.get(id);
  const alias = player?.alias ?? "";
  const color = player?.color ?? "#0B6E67";
  const plateTexture = useMemo(() => makeNameplate(alias, color), [alias, color]);

  useFrame((_, delta) => {
    const p = room.state.players.get(id);
    const head = headRef.current;
    if (!p || !head) return;

    head.position.x = MathUtils.damp(head.position.x, p.hx, 12, delta);
    head.position.y = MathUtils.damp(head.position.y, p.hy, 12, delta);
    head.position.z = MathUtils.damp(head.position.z, p.hz, 12, delta);
    head.rotation.y = dampAngle(head.rotation.y, p.yaw, 12, delta);
    head.rotation.x = MathUtils.damp(head.rotation.x, p.pitch, 12, delta);

    tmpHead.copy(head.position);
    onHeadPosition?.(p.voiceId, tmpHead.x, tmpHead.y, tmpHead.z);

    if (plateRef.current) {
      plateRef.current.position.set(tmpHead.x, tmpHead.y + 0.34, tmpHead.z);
      // El rotulo se atenua con la distancia en vez de desaparecer de golpe.
      const material = plateRef.current.material;
      material.opacity = p.handRaised ? 1 : 0.88;
    }

    if (ringRef.current) {
      ringRef.current.position.set(tmpHead.x, 0.008, tmpHead.z);
      const material = ringRef.current.material as { opacity: number };
      // El anillo se enciende con la voz: se sabe quien habla sin depender
      // solo del audio espacial.
      material.opacity = MathUtils.damp(
        material.opacity,
        p.speaking ? 0.95 : 0.25,
        10,
        delta,
      );
    }

    poseArm(-1, p.left, tmpHead, p.yaw, leftUpper.current, leftArm.current, leftHand.current, delta);
    poseArm(1, p.right, tmpHead, p.yaw, rightUpper.current, rightArm.current, rightHand.current, delta);
  });

  if (!player) return null;

  return (
    <group>
      <group ref={headRef} position={[player.hx, player.hy, player.hz]}>
        <mesh>
          <boxGeometry args={[0.2, 0.235, 0.2]} />
          <meshStandardMaterial color={color} roughness={0.6} />
        </mesh>
        {/* Visor: marca hacia donde mira la cabeza. */}
        <mesh position={[0, 0.015, -0.101]}>
          <planeGeometry args={[0.165, 0.075]} />
          <meshBasicMaterial color="#12191A" />
        </mesh>
      </group>

      <sprite ref={plateRef} scale={[0.62, 0.155, 1]}>
        <spriteMaterial map={plateTexture} transparent depthWrite={false} />
      </sprite>

      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.24, 0.3, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.25} />
      </mesh>

      <mesh ref={leftUpper}>
        <cylinderGeometry args={[0.5, 0.5, 1, 10]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh ref={rightUpper}>
        <cylinderGeometry args={[0.5, 0.5, 1, 10]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh ref={leftArm}>
        <cylinderGeometry args={[0.5, 0.5, 1, 10]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh ref={rightArm}>
        <cylinderGeometry args={[0.5, 0.5, 1, 10]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh ref={leftHand}>
        <sphereGeometry args={[0.052, 12, 10]} />
        <meshStandardMaterial color={color} roughness={0.55} />
      </mesh>
      <mesh ref={rightHand}>
        <sphereGeometry args={[0.052, 12, 10]} />
        <meshStandardMaterial color={color} roughness={0.55} />
      </mesh>
    </group>
  );
}

/** side: -1 izquierda, 1 derecha. */
function poseArm(
  side: number,
  input: { tracked: boolean; x: number; y: number; z: number },
  head: Vector3,
  yaw: number,
  upper: Mesh | null,
  arm: Mesh | null,
  hand: Mesh | null,
  delta: number,
) {
  if (!upper || !arm || !hand) return;
  const { tracked, x: wx, y: wy, z: wz } = input;

  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // Hombro: desplazamiento fijo bajo la cabeza, girado con ella.
  const ox = side * 0.19;
  const oy = -0.23;
  const oz = 0;
  tmpShoulder.set(head.x + ox * cos + oz * sin, head.y + oy, head.z - ox * sin + oz * cos);

  if (tracked) {
    tmpWrist.set(wx, wy, wz);
  } else {
    // Mano en reposo: colgando al lado del cuerpo.
    tmpWrist.set(tmpShoulder.x, tmpShoulder.y - 0.42, tmpShoulder.z + 0.06);
  }

  hand.visible = true;
  hand.position.lerp(tmpWrist, 1 - Math.exp(-14 * delta));

  // La pista empuja el codo hacia afuera y abajo, que es como cae un brazo
  // humano; sin ella el codo elige soluciones imposibles.
  tmpHint.set(side * 0.55 * cos, -1, -side * 0.55 * sin).normalize();
  solveElbow(tmpShoulder, hand.position, UPPER_ARM, FOREARM, tmpHint, tmpElbow);

  // Brazo completo: hombro a codo y codo a mano. Dibujar solo el antebrazo
  // deja un hueco entre la cabeza y las manos que se lee como piezas sueltas
  // flotando, no como una persona.
  orientBone(upper, tmpShoulder, tmpElbow, 0.088);
  orientBone(arm, tmpElbow, hand.position, 0.076);
}

function solveElbow(
  shoulder: Vector3,
  wrist: Vector3,
  l1: number,
  l2: number,
  hint: Vector3,
  out: Vector3,
) {
  tmpDir.subVectors(wrist, shoulder);
  let d = tmpDir.length();
  if (d < 1e-4) {
    out.copy(shoulder).addScaledVector(hint, l1);
    return;
  }
  tmpDir.divideScalar(d);
  d = Math.min(d, (l1 + l2) * 0.999);

  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));

  // Componente de la pista perpendicular al eje hombro-muneca.
  const projected = hint.dot(tmpDir);
  out.copy(hint).addScaledVector(tmpDir, -projected);
  if (out.lengthSq() < 1e-6) out.set(-tmpDir.y, tmpDir.x, 0);
  if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
  out.normalize().multiplyScalar(h);

  out.add(shoulder).addScaledVector(tmpDir, a);
}

function orientBone(mesh: Mesh, from: Vector3, to: Vector3, thickness: number) {
  tmpDir.subVectors(to, from);
  const length = tmpDir.length();
  if (length < 1e-4) {
    mesh.visible = false;
    return;
  }
  mesh.visible = true;
  mesh.position.copy(from).addScaledVector(tmpDir, 0.5);
  tmpDir.divideScalar(length);
  mesh.quaternion.setFromUnitVectors(UP, tmpDir);
  mesh.scale.set(thickness, length, thickness);
}

function dampAngle(current: number, target: number, lambda: number, delta: number) {
  // Por el camino corto: sin esto el avatar gira 350 grados para ver algo
  // que tiene a 10 grados.
  let difference = target - current;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return current + difference * (1 - Math.exp(-lambda * delta));
}

/**
 * Rotulo de nombre dibujado en un canvas.
 *
 * Sin dependencia de tipografias externas a proposito: en una sala de clase
 * sin buena conexion, una fuente que no carga deja los nombres invisibles.
 */
function makeNameplate(alias: string, color: string) {
  const width = 512;
  const height = 128;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  ctx.clearRect(0, 0, width, height);
  roundedRect(ctx, 6, 24, width - 12, 80, 14);
  ctx.fillStyle = "rgba(16, 26, 27, 0.82)";
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = color;
  ctx.stroke();

  ctx.font = "600 44px system-ui, 'Segoe UI', Roboto, sans-serif";
  ctx.fillStyle = "#F2F6F6";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(alias.slice(0, 16) || "?", width / 2, height / 2 + 2);

  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
