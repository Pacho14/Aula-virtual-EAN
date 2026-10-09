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
 *
 * ## Como se dibuja, y por que asi
 *
 * Nudos de luz y huesos de luz, los dos con **mezcla aditiva**. Eso da tres
 * cosas de una vez:
 *
 * - Brilla sin necesitar luces. Un material basico no se ilumina, asi que la
 *   mano se ve igual de nitida en un salon oscuro o con un entorno 360 muy
 *   claro detras.
 * - El resplandor sale **gratis**. Lo que normalmente se consigue con un paso
 *   de bloom a pantalla completa -inasumible con el presupuesto de 30 fps en
 *   un celular de gama media- aqui lo da la propia textura: un degradado
 *   radial sumado al fondo *es* un punto de luz. Donde dos huesos se cruzan,
 *   en los nudillos, las sumas se acumulan y la zona se enciende sola.
 * - Un nudo son dos triangulos y no una esfera de 48. Los 21 nudos de cada
 *   mano cuestan menos que antes, aunque se vean el doble.
 *
 * Los nudos son cuadros planos y no esferas, y eso funciona porque **el grupo
 * entero ya va orientado con la camara**: un plano mirando a +Z en
 * coordenadas del grupo mira a quien lo ve, siempre, sin recalcular nada por
 * cuadro.
 */
import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Camera,
} from "three";
import { INDEX_TIP, JOINT_COUNT, toViewSpace } from "../input/handSpace";
import { HAND_CONNECTIONS, type HandFrame } from "../input/types";

export interface HandSkeletonHandle {
  update(
    hand: HandFrame | null,
    world: Vector3,
    camera: Camera,
    color: string,
    /**
     * Si se dibuja la marca de apuntar sobre la punta del indice.
     *
     * Solo cuando el pellizco esta en marcha. Permanente era ruido: la punta
     * del indice ya se ve -es uno de los nudos, y de los grandes-, asi que una
     * segunda marca encima no añadia informacion y competia con el nudo por la
     * atencion. Marcando solo el pellizco, la marca pasa a querer decir algo:
     * **esto es lo que va a tomar**.
     */
    aiming: boolean,
  ): void;
}

const UP = new Vector3(0, 1, 0);
const tmpDir = new Vector3();
const tmpQuat = new Quaternion();
/** Los 21 puntos ya girados a los ejes de la vista. Se reusa cada cuadro. */
const viewPoints = new Float32Array(JOINT_COUNT * 3);
const localPositions: Vector3[] = Array.from({ length: JOINT_COUNT }, () => new Vector3());
const tmpColor = new Color();

/** La punta del indice, que es con lo que se apunta, va marcada aparte. */
const ACCENT = "#F2FBFF";

/**
 * Tamaño de cada nudo, en metros.
 *
 * No son todos iguales porque no todos dicen lo mismo. La muñeca ancla la
 * mano, las puntas de los dedos son lo que toca las cosas, y los nudillos dan
 * la forma de la palma; el resto solo une. Las puntas y la muñeca van mas
 * grandes para que la mano se lea de un vistazo incluso de lejos.
 */
function jointSize(i: number) {
  if (i === 0) return 0.03;
  // 4, 8, 12, 16, 20: las cinco puntas.
  if (i >= 4 && i % 4 === 0) return 0.024;
  // 5, 9, 13, 17: los nudillos.
  if (i >= 5 && (i - 5) % 4 === 0) return 0.02;
  return 0.015;
}

/**
 * Un punto de luz, dibujado una vez en un canvas y reusado por todos los nudos.
 *
 * El degradado es lo que hace el resplandor: el centro opaco da el nucleo y la
 * caida suave, sumada al fondo, da el halo. Se va a cero del todo en el borde
 * para que el cuadro no se note como cuadro.
 *
 * La curva no es lineal a proposito -el cuarto del radio aun va al 55 %- para
 * que el nucleo se vea compacto y el halo largo. Un degradado lineal da una
 * mancha difusa sin centro, que de lejos parece una mano borrosa en vez de
 * una mano de luz.
 */
function makeGlow() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.18, "rgba(255,255,255,0.95)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.55)");
  gradient.addColorStop(0.65, "rgba(255,255,255,0.16)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export const HandSkeleton = forwardRef<HandSkeletonHandle>(function HandSkeleton(_props, ref) {
  const group = useRef<Group>(null);
  const joints = useRef<(Mesh | null)[]>([]);
  const bones = useRef<(Mesh | null)[]>([]);
  const aim = useRef<Mesh>(null);

  // Una sola textura para los 21 nudos de las dos manos. Vive lo que vive el
  // componente, asi que no se vuelve a subir a la tarjeta en cada cuadro.
  const glow = useMemo(makeGlow, []);

  useImperativeHandle(ref, () => ({
    update(
      hand: HandFrame | null,
      world: Vector3,
      camera: Camera,
      color: string,
      aiming: boolean,
    ) {
      const g = group.current;
      if (!g) return;

      if (!hand?.worldLandmarks) {
        g.visible = false;
        return;
      }
      g.visible = true;
      g.position.copy(world);
      g.quaternion.copy(camera.quaternion);

      tmpColor.set(color);

      toViewSpace(hand.worldLandmarks, viewPoints);
      for (let i = 0; i < JOINT_COUNT; i++) {
        const x = viewPoints[i * 3]!;
        const y = viewPoints[i * 3 + 1]!;
        const z = viewPoints[i * 3 + 2]!;
        localPositions[i]!.set(x, y, z);
        const mesh = joints.current[i];
        if (mesh) {
          mesh.position.set(x, y, z);
          (mesh.material as MeshBasicMaterial).color.copy(tmpColor);
        }
      }

      // La marca de apuntar, encima de la punta del indice y un poco por
      // delante para que su halo no quede comido por el del nudo. Solo
      // mientras se pellizca: ver `aiming`.
      const marker = aim.current;
      if (marker) {
        marker.visible = aiming;
        if (aiming) {
          const tip = localPositions[INDEX_TIP]!;
          marker.position.set(tip.x, tip.y, tip.z + 0.004);
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
        (bone.material as MeshBasicMaterial).color.copy(tmpColor);
      }
    },
  }));

  return (
    <group ref={group} visible={false}>
      {Array.from({ length: JOINT_COUNT }, (_, i) => {
        const size = jointSize(i);
        return (
          <mesh
            key={`j${i}`}
            ref={(m) => {
              joints.current[i] = m;
            }}
            raycast={() => null}
          >
            <planeGeometry args={[size, size]} />
            <meshBasicMaterial
              map={glow}
              transparent
              blending={AdditiveBlending}
              // Aditivo y sin escribir profundidad: dos nudos que se cruzan
              // suman en vez de taparse, que es de donde sale el resplandor de
              // los nudillos. Con depthWrite el que se dibujara primero
              // recortaria al otro y la mano saldria a parches.
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        );
      })}

      {/* La marca de apuntar: el mismo punto de luz, mas grande y mas frio. */}
      <mesh ref={aim} visible={false} raycast={() => null}>
        <planeGeometry args={[0.038, 0.038]} />
        <meshBasicMaterial
          map={glow}
          color={ACCENT}
          transparent
          opacity={0.75}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {HAND_CONNECTIONS.map((_, i) => (
        <mesh
          key={`b${i}`}
          ref={(m) => {
            bones.current[i] = m;
          }}
          raycast={() => null}
        >
          <cylinderGeometry args={[0.0026, 0.0026, 1, 5]} />
          <meshBasicMaterial
            transparent
            // Por debajo de los nudos a proposito: los huesos son la
            // estructura y los nudos son donde pasa algo. Al sumarse, un hueso
            // tenue entre dos nudos brillantes es justo lo que lee como
            // tendon de luz.
            opacity={0.5}
            blending={AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
});
