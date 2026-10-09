/**
 * El cursor de la mano, y el rayo que lo produce.
 *
 * Lo comparten la sala y el lobby. Son dos escenas distintas -una con
 * servidor y otra sin él- pero apuntar se siente igual en las dos, y el
 * anillo que se llena mientras se sostiene la mano sobre un botón es lo que
 * enseña a usar la interfaz: tenerlo escrito dos veces sería tenerlo distinto
 * en cuanto alguien tocara uno de los dos.
 *
 * ## Por qué es una retícula y no un punto
 *
 * Un cursor de mano tiene que decir dos cosas a la vez -dónde apunta y si lo
 * que hay debajo responde- y tiene que
 * decirlas sobre un fondo que puede ser un entorno 360 de cualquier color. De
 * ahí las tres piezas:
 *
 * - El **contorno**, que es lo que lo hace visible. Oscuro y detrás de todo.
 * - El **núcleo**, que es el dónde. Pequeño, para que no tape lo que señala.
 * - El **cerco**, que es el si-responde. Crece al posarse sobre algo.
 *
 * Ya no hay arco de espera: se fue con la espera sostenida. Ahora el botón se
 * pulsa en el instante de cerrar la mano, así que no queda nada que llenar.
 *
 * ## El contorno no es adorno, y aquí está la lección
 *
 * Esto estuvo dibujado con **mezcla aditiva**, que suma luz sobre el fondo. Es
 * lo correcto para la mano -ver HandSkeleton, donde además da el resplandor
 * gratis- y es exactamente lo contrario de lo que sirve aquí: **el lobby tiene
 * el fondo casi blanco** (`#EDF1F1`), y sumar cian sobre blanco no cambia
 * nada: el cursor desaparecía entero.
 *
 * Lo que vale para los dos extremos no es un color: es **contraste propio**.
 * Un núcleo opaco con un contorno oscuro detrás se ve igual contra un cielo
 * de mediodía y contra una pared en sombra, sin depender de lo que haya
 * debajo.
 *
 * ## Por qué todas son transparentes y van con `renderOrder` alto
 *
 * No es decoración, es lo que hace que el cursor **se vea**. three dibuja
 * primero la cola de opacos y después la de transparentes, así que un material
 * sin `transparent` entra en la primera. Si además lleva `depthWrite: false`
 * -que hace falta para que no recorte a sus propias piezas- el resultado es
 * que el cursor se pinta antes que la escena y no deja huella de profundidad:
 * **cada portal que se dibuje después lo tapa**. Con `renderOrder` negativo,
 * encima, se pintaba de los primeros.
 *
 * Así desapareció el cursor del lobby entero. Lo correcto es lo contrario de
 * lo que parece: transparente y con `renderOrder` alto, para que salga el
 * último de todos y quede delante de todo.
 */

/** Por encima de cualquier cosa de la escena. El cursor siempre va delante. */
const ORDER = { outline: 900, core: 901, ring: 902 } as const;

/** Tramos del arco. Seis índices por tramo al recortar el rango de dibujo. */
const SEGMENTS = 24;
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
  /** Avance del contador sobre una pieza, de 0 a 1. */
  dwell: 0,
};

export function HandCursor() {
  const { camera } = useThree();
  const core = useRef<Mesh>(null);
  const outline = useRef<Mesh>(null);
  const halo = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);

  useFrame(() => {
    const mesh = core.current;
    if (!mesh) return;

    mesh.visible = cursorState.visible;
    if (cursorState.visible) {
      mesh.position
        .copy(handRay.ray.origin)
        .addScaledVector(handRay.ray.direction, cursorState.distance);
      mesh.lookAt(camera.position);
      // Más grande que antes (era 0,032 y 0,055). A tres metros y medio -lo
      // que hay hasta los portales del lobby- el cursor de antes medía unos
      // pocos píxeles: se veía solo si ya sabías dónde mirar.
      mesh.scale.setScalar(cursorState.big ? 0.085 : 0.055);
    }

    // El contorno, el cerco y el arco cuelgan del núcleo: comparten sitio y
    // orientación, y así no hay dos sitios donde se decida dónde está el
    // cursor.
    const borde = outline.current;
    if (borde) {
      borde.visible = cursorState.visible;
      if (borde.visible) {
        borde.position.copy(mesh.position);
        borde.quaternion.copy(mesh.quaternion);
        borde.scale.setScalar(mesh.scale.x);
      }
    }

    const cerco = halo.current;
    if (cerco) {
      cerco.visible = cursorState.visible;
      if (cerco.visible) {
        cerco.position.copy(mesh.position);
        cerco.quaternion.copy(mesh.quaternion);
        cerco.scale.setScalar(mesh.scale.x);
      }
    }

    const anillo = ring.current;
    if (anillo) {
      anillo.visible = cursorState.visible && cursorState.dwell > 0.02;
      if (anillo.visible) {
        anillo.position.copy(mesh.position);
        anillo.quaternion.copy(mesh.quaternion);
        anillo.scale.setScalar(mesh.scale.x * 1.5);
        // Recortar el rango de dibujo pinta solo los tramos recorridos, sin
        // rehacer la geometría. De paso es lo que lo hace verse a tramos: un
        // arco liso al 20 % es un detalle que se pierde, y cinco tramos
        // encendidos de veinticuatro se cuentan de un vistazo.
        anillo.geometry.setDrawRange(0, Math.round(cursorState.dwell * SEGMENTS) * 6);
      }
    }

  });

  return (
    <group>
      {/*
        El contorno: un disco oscuro algo más grande que el núcleo. El borde
        que asoma es lo que separa al cursor de un fondo claro, y es lo que le
        da contraste propio sin depender de lo que tenga detrás.
      */}
      <mesh ref={outline} visible={false} renderOrder={ORDER.outline} raycast={() => null}>
        <circleGeometry args={[0.66, 24]} />
        <meshBasicMaterial
          color="#06161C"
          transparent
          opacity={0.8}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* El núcleo: cubre, no suma. Se ve sobre cualquier cosa. */}
      <mesh ref={core} visible={false} renderOrder={ORDER.core} raycast={() => null}>
        <circleGeometry args={[0.44, 20]} />
        <meshBasicMaterial
          color="#2BE8FF"
          transparent
          opacity={1}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/*
        El cerco: dice que lo de debajo responde. Cian y cubriendo, no sumando
        -el color nunca fue el problema; el problema era sumar en vez de
        cubrir. Un cian así se distingue igual del blanco del lobby que del
        cielo de un entorno 360.
      */}
      <mesh ref={halo} visible={false} renderOrder={ORDER.core} raycast={() => null}>
        <ringGeometry args={[0.8, 1.0, 32]} />
        <meshBasicMaterial
          color="#2BE8FF"
          transparent
          opacity={1}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* El contador: se llena mientras sostienes la mano sobre una pieza. */}
      <mesh ref={ring} visible={false} renderOrder={ORDER.ring} raycast={() => null}>
        <ringGeometry args={[1.15, 1.5, SEGMENTS]} />
        <meshBasicMaterial
          color="#FF2BD6"
          transparent
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
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
