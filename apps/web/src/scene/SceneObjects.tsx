import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { Color, MathUtils, type Mesh, type MeshStandardMaterial } from "three";
import type { AulaRoom } from "../net/room";
import { predicted, registerGrabbable } from "./registry";

/**
 * Los assets de la escena.
 *
 * El servidor es la autoridad: aqui nunca se decide si un objeto se puede
 * mover. La posicion se interpola hacia la que llega del estado, y quien lo
 * tiene agarrado ve su propia mano sin esperar el viaje de ida y vuelta
 * porque su cliente ya movio el objeto antes de enviarlo.
 */
export function SceneObjects({
  room,
  ids,
  sessionId,
  hoveredRef,
}: {
  room: AulaRoom;
  ids: string[];
  sessionId: string;
  hoveredRef: React.RefObject<string | null>;
}) {
  return (
    <group>
      {ids.map((id) => (
        <SceneObjectMesh
          key={id}
          id={id}
          room={room}
          sessionId={sessionId}
          hoveredRef={hoveredRef}
        />
      ))}
    </group>
  );
}

const tint = new Color();

function SceneObjectMesh({
  id,
  room,
  sessionId,
  hoveredRef,
}: {
  id: string;
  room: AulaRoom;
  sessionId: string;
  hoveredRef: React.RefObject<string | null>;
}) {
  const meshRef = useRef<Mesh>(null);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    const object = room.state.objects.get(id);
    if (!mesh || !object) return;

    const mine = predicted.get(id);
    if (object.heldBy === sessionId && mine) {
      // Lo que uno mismo arrastra se dibuja donde la mano lo puso, sin
      // esperar el eco del servidor.
      mesh.position.copy(mine);
    } else {
      // Interpolacion: el estado llega a 20 Hz y el render corre a 60.
      mesh.position.x = MathUtils.damp(mesh.position.x, object.x, 14, delta);
      mesh.position.y = MathUtils.damp(mesh.position.y, object.y, 14, delta);
      mesh.position.z = MathUtils.damp(mesh.position.z, object.z, 14, delta);
    }
    mesh.rotation.y = MathUtils.damp(mesh.rotation.y, object.ry, 14, delta);

    const material = mesh.material as MeshStandardMaterial;
    const held = object.heldBy !== "";
    const heldByMe = object.heldBy === sessionId;
    const hovered = hoveredRef.current === id && !held;

    // Realimentacion de estado en el color: libre, apuntado, o en manos de
    // alguien. Sin esto no se sabe por que un objeto no responde.
    tint.set(object.color);
    if (heldByMe) tint.offsetHSL(0, 0.05, 0.16);
    else if (held) tint.offsetHSL(0, -0.25, 0.1);
    else if (hovered) tint.offsetHSL(0, 0, 0.1);
    material.color.lerp(tint, 1 - Math.exp(-12 * delta));
    material.emissive.setRGB(0, 0, 0);
    if (hovered || heldByMe) {
      material.emissive.set(heldByMe ? "#0B6E67" : "#7A8886");
      material.emissiveIntensity = heldByMe ? 0.35 : 0.18;
    }
  });

  // Se lee despues de los hooks: el id siempre viene de la lista que mantiene
  // onAdd/onRemove, pero el estado puede desaparecer entre render y render.
  const state = room.state.objects.get(id);
  if (!state) return null;

  const primitive = state.src.startsWith("prim:") ? state.src.slice(5) : "box";

  return (
    <mesh
      ref={(mesh) => {
        meshRef.current = mesh;
        // Solo los objetos interactivos entran al raycast: apuntarle a la
        // mesa fija no deberia siquiera encender el cursor.
        if (state.interactive && !state.locked) registerGrabbable(id, mesh);
      }}
      position={[state.x, state.y, state.z]}
      rotation={[0, state.ry, 0]}
      userData={{ objectId: id }}
    >
      {primitive === "cylinder" ? (
        <cylinderGeometry args={[state.sx / 2, state.sx / 2, state.sy, 20]} />
      ) : primitive === "sphere" ? (
        <sphereGeometry args={[state.sx / 2, 20, 16]} />
      ) : (
        <boxGeometry args={[state.sx, state.sy, state.sz]} />
      )}
      <meshStandardMaterial color={state.color} roughness={0.55} metalness={0.05} />
    </mesh>
  );
}
