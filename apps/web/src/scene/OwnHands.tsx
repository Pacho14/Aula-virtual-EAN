/**
 * Las propias manos dentro de la escena, para quien las necesite.
 *
 * Vive aparte porque **hay dos sitios que dibujan las mismas manos**: el salón
 * y el lobby. Antes solo las dibujaba el salón, y el lobby se quedaba con el
 * cursor a secas: entrabas, veías el detector funcionando en el recuadro de
 * depuración y aun así no tenías manos hasta después de escribir el código.
 * Teniendo esto escrito dos veces, estaría distinto en cuanto alguien tocara
 * uno de los dos.
 *
 * Lo que decide **dónde** va cada mano está en `projectHand`, y lo que decide
 * **cómo** se ve está en HandSkeleton.
 */
import { forwardRef, useImperativeHandle, useRef } from "react";
import { Vector2, Vector3, type Camera } from "three";
import { INDEX_TIP, jointInViewSpace, palmInViewSpace, viewDepth, type Vec3 } from "../input/handSpace";
import type { HandFrame } from "../input/types";
import { handRay } from "../ui3d/HandCursor";
import { HandSkeleton, type HandSkeletonHandle } from "./HandSkeleton";

/** Color de la mano propia según el gesto: realimentación inmediata. */
export const HAND_COLORS: Record<string, string> = {
  none: "#2F5E6B",
  point: "#00D9FF",
  pinch: "#FF2BD6",
  fist: "#FFA62B",
  open: "#9DFF3C",
};

const ndc = new Vector2();
/** Cuánto separa el ancla de la muñeca. Ver `projectHand`. */
const anchorOffset: Vec3 = [0, 0, 0];
const anchorWorld = new Vector3();

/**
 * Dónde va una mano dentro de la escena.
 *
 * Sin cursor permanente, la mano es la marca de hacia dónde se apunta, así que
 * el rayo tiene que pasar **por la mano dibujada** o se apuntaría a un sitio y
 * se seleccionaría otro.
 *
 * Eso no sale solo. El rayo lleva la ganancia de cameraSource.ts -para que un
 * movimiento corto alcance toda la pantalla- mientras que la forma de la mano
 * va en metros reales, sin amplificar. Así que se coloca al revés de lo
 * normal: primero se calcula dónde tiene que caer el punto con el que se
 * apunta, y después se retrocede lo que ese punto se separa de la muñeca, que
 * es por donde se ancla el grupo.
 *
 * `byPalm` cambia el ancla **y** el rayo a la vez, y tiene que cambiar los
 * dos: con una pieza en la mano se apunta con el centro de la palma, porque la
 * punta del índice se desploma al abrir la mano y movería la pieza justo al
 * soltarla.
 *
 * De fondo la mano va a la profundidad que diga `viewDepth`. Estirar el brazo
 * hacia la pantalla acerca la mano a la webcam, que es alejarla de los propios
 * ojos, así que la mano se adentra en la escena; recogerla la trae hacia la
 * cara, donde se ve grande solo por perspectiva, porque su tamaño en metros no
 * cambia nunca.
 */
export function projectHand(hand: HandFrame, camera: Camera, out: Vector3, byPalm: boolean) {
  if (byPalm) ndc.set(hand.ndcX, hand.ndcY);
  else ndc.set(hand.indexNdcX, hand.indexNdcY);
  handRay.setFromCamera(ndc, camera);
  out
    .copy(handRay.ray.origin)
    .addScaledVector(handRay.ray.direction, viewDepth(hand.cameraDistance));

  if (!hand.worldLandmarks) return;
  if (byPalm) palmInViewSpace(hand.worldLandmarks, anchorOffset);
  else jointInViewSpace(hand.worldLandmarks, INDEX_TIP, anchorOffset);
  anchorWorld
    .set(anchorOffset[0], anchorOffset[1], anchorOffset[2])
    .applyQuaternion(camera.quaternion);
  out.sub(anchorWorld);
}

export interface OwnHandsHandle {
  /**
   * Coloca y dibuja las dos manos, y devuelve dónde quedaron.
   *
   * `carrying` manda sobre las dos a la vez y no solo sobre la que lleva la
   * pieza: son las dos manos de la misma persona, y anclar una por el dedo y
   * la otra por la palma las pondría a profundidades distintas sin que nada lo
   * explicara.
   *
   * `draw: false` **coloca pero no dibuja**, y los dos pasos van separados a
   * propósito: el profesor armando el salón no ve sus manos -la pantalla es
   * casi toda paneles y se las taparían-, pero su posición sigue viajando en
   * la pose, así que los demás sí ven sus manos moverse.
   */
  update(
    left: HandFrame | null,
    right: HandFrame | null,
    camera: Camera,
    options?: { carrying?: boolean; draw?: boolean },
  ): { left: Vector3; right: Vector3 };
}

export const OwnHands = forwardRef<OwnHandsHandle>(function OwnHands(_props, ref) {
  const leftHand = useRef<HandSkeletonHandle>(null);
  const rightHand = useRef<HandSkeletonHandle>(null);
  const world = useRef({ left: new Vector3(), right: new Vector3() });

  useImperativeHandle(ref, () => ({
    update(left, right, camera, options) {
      const carrying = options?.carrying ?? false;
      const visible = options?.draw ?? true;
      if (left) projectHand(left, camera, world.current.left, carrying);
      if (right) projectHand(right, camera, world.current.right, carrying);

      // La marca de apuntar solo mientras se pellizca, y solo con la mano
      // libre: con una pieza ya tomada no hay nada que apuntar.
      draw(leftHand.current, visible ? left : null, world.current.left, camera, !carrying);
      draw(rightHand.current, visible ? right : null, world.current.right, camera, !carrying);
      return world.current;
    },
  }));

  return (
    <>
      <HandSkeleton ref={leftHand} />
      <HandSkeleton ref={rightHand} />
    </>
  );
});

function draw(
  skeleton: HandSkeletonHandle | null,
  hand: HandFrame | null,
  position: Vector3,
  camera: Camera,
  canAim: boolean,
) {
  if (!skeleton) return;
  const color = hand ? (HAND_COLORS[hand.gesture] ?? HAND_COLORS.none!) : HAND_COLORS.none!;
  skeleton.update(hand, position, camera, color, canAim && hand?.gesture === "pinch");
}
