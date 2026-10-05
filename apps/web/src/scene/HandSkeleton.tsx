/**
 * La propia mano, dibujada como el esqueleto de 21 puntos de MediaPipe en vez
 * de una esfera.
 *
 * Usa `worldLandmarks` -metros reales relativos a la muñeca, ya resueltos
 * por el modelo- y no `landmarks` (normalizado a la imagen). La forma en
 * coordenadas de imagen se encoge o se infla segun que tan cerca este la
 * mano de la camara o en que angulo este girada; reconstruir un tamano desde
 * ahi con una sola medida (ver versiones anteriores de este archivo) es
 * justo lo que producia manos "fantasma" gigantes o estiradas. Con
 * `worldLandmarks` la proporcion de la mano ya viene resuelta: no hay nada
 * que normalizar.
 *
 * Vive en un plano que siempre mira a la camara -como el cursor de
 * HandCursor.tsx-, porque MediaPipe calcula sus landmarks respecto a su
 * propia camara 2D, sin relacion con los ejes de la escena 3D: girar la
 * cabeza no deberia girar la mano con ella.
 */
import { forwardRef, useImperativeHandle, useRef } from "react";
import { Group, Mesh, MeshStandardMaterial, Quaternion, Vector3, type Camera } from "three";
import { HAND_CONNECTIONS, type HandFrame } from "../input/types";

export interface HandSkeletonHandle {
  update(hand: HandFrame | null, world: Vector3, camera: Camera, color: string): void;
}

const JOINT_COUNT = 21;
/**
 * `worldLandmarks` ya viene en metros reales. Este factor es solo ajuste de
 * estilo -una mano a tamano real se ve pequeña a la distancia fija del
 * cursor-, no una reconstruccion de escala.
 */
const SCALE = 1.15;

const UP = new Vector3(0, 1, 0);
const tmpDir = new Vector3();
const tmpQuat = new Quaternion();
const localPositions: Vector3[] = Array.from({ length: JOINT_COUNT }, () => new Vector3());

export const HandSkeleton = forwardRef<HandSkeletonHandle>(function HandSkeleton(_props, ref) {
  const group = useRef<Group>(null);
  const joints = useRef<(Mesh | null)[]>([]);
  const bones = useRef<(Mesh | null)[]>([]);

  useImperativeHandle(ref, () => ({
    update(hand: HandFrame | null, world: Vector3, camera: Camera, color: string) {
      const g = group.current;
      if (!g) return;

      if (!hand?.worldLandmarks) {
        g.visible = false;
        return;
      }
      g.visible = true;
      g.position.copy(world);
      g.quaternion.copy(camera.quaternion);

      const wl = hand.worldLandmarks;
      const wx = wl[0]!;
      const wy = wl[1]!;
      const wz = wl[2]!;
      for (let i = 0; i < JOINT_COUNT; i++) {
        // Espejo en X, igual que el resto de la entrada (cameraSource.ts,
        // el overlay 2D): la captura nunca se espeja antes de MediaPipe, asi
        // que hay que espejar aqui para que la mano se sienta como un
        // espejo de verdad. En Z se invierte para que "mas cerca de la
        // camara" de MediaPipe quede "hacia quien mira" en este grupo, que
        // es como lo define `HandCursor`.
        const x = -(wl[i * 3]! - wx) * SCALE;
        const y = -(wl[i * 3 + 1]! - wy) * SCALE;
        const z = -(wl[i * 3 + 2]! - wz) * SCALE;
        localPositions[i]!.set(x, y, z);
        const mesh = joints.current[i];
        if (mesh) {
          mesh.position.set(x, y, z);
          (mesh.material as MeshStandardMaterial).color.set(color);
        }
      }

      for (let i = 0; i < HAND_CONNECTIONS.length; i++) {
        const bone = bones.current[i];
        if (!bone) continue;
        const [a, b] = HAND_CONNECTIONS[i]!;
        const from = localPositions[a]!;
        const to = localPositions[b]!;
        tmpDir.subVectors(to, from);
        const length = tmpDir.length();
        if (length < 1e-4) {
          bone.visible = false;
          continue;
        }
        bone.visible = true;
        bone.position.copy(from).addScaledVector(tmpDir, 0.5);
        tmpDir.divideScalar(length);
        tmpQuat.setFromUnitVectors(UP, tmpDir);
        bone.quaternion.copy(tmpQuat);
        bone.scale.set(1, length, 1);
        (bone.material as MeshStandardMaterial).color.set(color);
      }
    },
  }));

  return (
    <group ref={group} visible={false}>
      {Array.from({ length: JOINT_COUNT }, (_, i) => (
        <mesh
          key={`j${i}`}
          ref={(m) => {
            joints.current[i] = m;
          }}
          raycast={() => null}
        >
          {/* La muñeca y las puntas de los dedos, un poco más grandes. */}
          <sphereGeometry args={[i === 0 || i % 4 === 0 ? 0.012 : 0.008, 8, 6]} />
          <meshStandardMaterial roughness={0.5} />
        </mesh>
      ))}
      {HAND_CONNECTIONS.map((_, i) => (
        <mesh
          key={`b${i}`}
          ref={(m) => {
            bones.current[i] = m;
          }}
          raycast={() => null}
        >
          <cylinderGeometry args={[0.0035, 0.0035, 1, 6]} />
          <meshStandardMaterial roughness={0.5} />
        </mesh>
      ))}
    </group>
  );
});
