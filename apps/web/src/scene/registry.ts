import type { Object3D, Vector3 } from "three";

/**
 * Posicion predicha del objeto que este cliente tiene agarrado.
 *
 * Mientras uno arrastra algo, su propio objeto no espera el viaje de ida y
 * vuelta al servidor: se dibuja donde la mano lo puso. El servidor sigue
 * siendo la autoridad para todos los demas, y en cuanto se suelta el objeto
 * vuelve a interpolar contra el estado.
 */
export const predicted = new Map<string, Vector3>();

/**
 * Mallas que el rayo puede tocar, por id de objeto.
 *
 * Un mapa a nivel de modulo en vez de contexto de React: el raycast corre en
 * cada cuadro y no debe pasar por el arbol de React para encontrar candidatos.
 * Hay una sola escena viva a la vez, asi que no hay ambiguedad.
 */
export const grabbables = new Map<string, Object3D>();

/**
 * Las mismas mallas que `grabbables`, en un array.
 *
 * El raycast del puntero corre 60 veces por segundo y pide un array, no un
 * Map; reconstruirlo con `[...grabbables.values()]` en cada cuadro aloja
 * memoria sin necesidad. Este array se actualiza solo cuando algo entra o
 * sale, no por cuadro.
 */
export const grabbablesList: Object3D[] = [];

export function registerGrabbable(id: string, object: Object3D | null) {
  const previous = grabbables.get(id);
  if (previous) {
    const index = grabbablesList.indexOf(previous);
    if (index !== -1) grabbablesList.splice(index, 1);
  }
  if (object) {
    grabbables.set(id, object);
    grabbablesList.push(object);
  } else {
    grabbables.delete(id);
  }
}

/**
 * Pieza que acaba de salir del panel de objetos y hay que tomar sin soltar.
 *
 * Sacar una pieza y agarrarla son un solo gesto para quien lo hace: se elige
 * el cubo y se lleva a la mesa. Si hubiera que elegirlo, buscarlo sobre el
 * tablero y volver a cerrar el puño, el panel se sentiría como un formulario.
 * El servidor confirma el id al crearla y la escena la engancha a la mano.
 */
export const autoGrab = {
  id: null as string | null,
  /**
   * Cuándo se pidió. El aviso del servidor y el estado con la pieza dentro
   * son dos caminos distintos: el mensaje llega al instante y el estado en el
   * siguiente tick, hasta 50 ms después. Intentarlo una sola vez fallaba una
   * de cada tantas veces, así que se reintenta durante esta ventana.
   */
  since: 0,
};

/** Cuánto se sigue intentando enganchar la pieza recién creada. */
export const AUTO_GRAB_WINDOW_MS = 1500;

/**
 * Giro y altura del entorno mientras el profesor arrastra los deslizadores.
 *
 * El servidor sigue siendo la autoridad, pero su eco tarda un tick: sin esto,
 * el paisaje se mueve medio palmo por detrás de la mano y el deslizador se
 * siente pegajoso. En null cuando nadie los está tocando.
 */
export const envPredicted = {
  x: null as number | null,
  y: null as number | null,
  z: null as number | null,
  rot: null as number | null,
  scale: null as number | null,
};
