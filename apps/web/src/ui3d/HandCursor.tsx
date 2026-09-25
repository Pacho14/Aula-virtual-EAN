/**
 * El cursor de la mano, y el rayo que lo produce.
 *
 * Lo comparten la sala y el lobby. Son dos escenas distintas -una con
 * servidor y otra sin él- pero apuntar se siente igual en las dos, y el
 * anillo que se llena mientras se sostiene la mano sobre un botón es lo que
 * enseña a usar la interfaz: tenerlo escrito dos veces sería tenerlo distinto
 * en cuanto alguien tocara uno de los dos.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import { Raycaster, type Mesh } from "three";
import { pointer } from "./widgets";

/** El rayo del puntero. Uno solo: hay una escena viva a la vez. */
export const handRay = new Raycaster();

export const cursorState = {
  visible: false,
  /** A qué distancia del ojo se dibuja. */
  distance: 2.6,
  /** Más grande cuando apunta a algo que responde. */
  big: false,
  /** Avance de la espera sostenida, de 0 a 1. */
  dwell: 0,
};

export function HandCursor() {
  const { camera } = useThree();
  const cursor = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);

  useFrame(() => {
    const mesh = cursor.current;
    if (!mesh) return;

    mesh.visible = cursorState.visible;
    if (cursorState.visible) {
      mesh.position
        .copy(handRay.ray.origin)
        .addScaledVector(handRay.ray.direction, cursorState.distance);
      mesh.lookAt(camera.position);
      mesh.scale.setScalar(cursorState.big ? 0.055 : 0.032);
    }

    const anillo = ring.current;
    if (!anillo) return;
    anillo.visible = cursorState.visible && cursorState.dwell > 0.02;
    if (anillo.visible) {
      anillo.position.copy(mesh.position);
      anillo.quaternion.copy(mesh.quaternion);
      anillo.scale.setScalar(mesh.scale.x * 1.5);
      // Un anillo de 24 tramos son 6 indices por tramo: recortar el rango de
      // dibujo pinta solo el arco recorrido, sin rehacer la geometria.
      anillo.geometry.setDrawRange(0, Math.round(cursorState.dwell * 24) * 6);
    }
  });

  return (
    <group>
      <mesh ref={cursor} visible={false} raycast={() => null}>
        <ringGeometry args={[0.6, 1, 24]} />
        <meshBasicMaterial color="#0B6E67" transparent opacity={0.85} depthTest={false} />
      </mesh>
      <mesh ref={ring} visible={false} raycast={() => null}>
        <ringGeometry args={[1.15, 1.45, 24]} />
        <meshBasicMaterial color="#12938A" transparent opacity={0.95} depthTest={false} />
      </mesh>
    </group>
  );
}

/** Deja el cursor como si no hubiera mano. */
export function hideCursor() {
  cursorState.visible = false;
  cursorState.dwell = 0;
  pointer.hoveredId = null;
}
