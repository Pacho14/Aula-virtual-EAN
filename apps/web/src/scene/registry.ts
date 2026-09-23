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

export function registerGrabbable(id: string, object: Object3D | null) {
  if (object) grabbables.set(id, object);
  else grabbables.delete(id);
}
