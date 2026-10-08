/**
 * La propia mano, dibujada como el esqueleto de 21 puntos de MediaPipe en vez
 * de una esfera.
 *
 * Dentro del salon esto **es el puntero**: no se dibuja ningun cursor. Las dos
 * marcas a la vez no funcionan, porque el cursor lleva la ganancia de
 * cameraSource.ts -para que un movimiento corto alcance toda la pantalla- y
 * la forma de la mano va en metros reales, sin amplificar: nunca caen en el
 * mismo sitio. El lobby si lleva cursor, porque alli no se dibuja mano.
 *
 * Quien llama a `update` es responsable de anclar el grupo donde toca: ver
 * `projectHand` en LocalPlayer, que coloca la punta del indice sobre el rayo
 * y retrocede hasta la muñeca.
 *
 * Usa `worldLandmarks` -metros reales relativos a la muñeca, ya resueltos
 * por el modelo- y no `landmarks` (normalizado a la imagen). La forma en
 * coordenadas de imagen se encoge o se infla segun que tan cerca este la
 * mano de la camara o en que angulo este girada; reconstruir un tamano desde
 * ahi con una sola medida (ver versiones anteriores de este archivo) es
 * justo lo que producia manos "fantasma" gigantes o estiradas. Con
 * `worldLandmarks` la proporcion de la mano ya viene resuelta: no hay nada
 * que normalizar, y aqui no se escala nada. El tamaño en pantalla lo decide
 * solo la perspectiva, es decir a que profundidad coloque el grupo quien
 * llame a `update`.
 *
 * El grupo se orienta con la camara, y eso no es un truco de cartel: los 21
 * puntos vienen expresados en los ejes de la camara (ver handSpace.ts), asi
 * que copiar su giro es exactamente lo que los lleva al mundo. Es tambien lo
 * correcto en primera persona: la mano va delante de los ojos, asi que girar
 * la vista la lleva consigo.
 *
 * La conversion de ejes esta en handSpace.ts, aparte y sin dependencias, para
 * poder probarla sin navegador. Importa: negar los tres ejes -que es lo que
 * hacia este archivo antes- es una reflexion, y dibujaba la mano derecha con
 * la forma de una izquierda y los dedos estirados apuntando a la propia cara.
 */
import { forwardRef, useImperativeHandle, useRef } from "react";
import { Group, Mesh, MeshStandardMaterial, Quaternion, Vector3, type Camera } from "three";
import { JOINT_COUNT, toViewSpace } from "../input/handSpace";
import { HAND_CONNECTIONS, type HandFrame } from "../input/types";

export interface HandSkeletonHandle {
  update(hand: HandFrame | null, world: Vector3, camera: Camera, color: string): void;
}

const UP = new Vector3(0, 1, 0);
const tmpDir = new Vector3();
const tmpQuat = new Quaternion();
/** Los 21 puntos ya girados a los ejes de la vista. Se reusa cada cuadro. */
const viewPoints = new Float32Array(JOINT_COUNT * 3);
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

      toViewSpace(hand.worldLandmarks, viewPoints);
      for (let i = 0; i < JOINT_COUNT; i++) {
        const x = viewPoints[i * 3]!;
        const y = viewPoints[i * 3 + 1]!;
        const z = viewPoints[i * 3 + 2]!;
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
