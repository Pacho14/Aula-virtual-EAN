/**
 * El puntero contra la interfaz espacial.
 *
 * ## Una sola regla
 *
 *   **Cierras la mano, tomas. Abres la mano, sueltas.**
 *
 * Vale para un botón, para un deslizador y para una pieza de la mesa, y no hay
 * nada más que aprender. Es el modelo de los visores: el pellizco es el clic,
 * mantenerlo es arrastrar y soltarlo es soltar.
 *
 * ## Lo que había antes, y por qué se fue
 *
 * Había tres caminos conviviendo: pellizcar, cerrar el puño, y **apuntar y
 * esperar** a que se llenara un anillo. Cada uno hacía algo ligeramente
 * distinto según dónde cayera -el pellizco pulsaba un botón pero soltaba una
 * pieza-, así que la misma mano significaba cosas opuestas a un palmo de
 * distancia. Eso no es tener opciones, es tener un acertijo.
 *
 * La espera sostenida existía porque el pellizco se leía mal con el detector
 * lento, y era una solución razonable a un problema que hay que arreglar en el
 * detector, no en la gramática de la interfaz. Lo que filtra el ruido ahora es
 * `GestureStabilizer`, que pide sostener el gesto antes de darlo por bueno.
 *
 * Pellizco y puño cuentan **los dos** como cerrar la mano. No son dos reglas:
 * es una sola regla que admite dos formas de hacerla, y las dos significan lo
 * mismo, así que no hay nada que decidir.
 */
import { Plane, Quaternion, Vector3, type Raycaster } from "three";
import { pointer, widgets, type Widget } from "./widgets";

/**
 * Cuánto hay que sostener la mano sobre una pieza para tomarla.
 *
 * Vive aquí, con el resto de la interacción, aunque el contador lo lleve la
 * escena: el anillo que lo dibuja está en `HandCursor` y el temporizador en
 * `LocalPlayer`, y si cada uno llevara su propio número se desincronizarían en
 * cuanto alguien tocara uno.
 *
 * Los botones **no** lo usan, y es deliberado: un botón es una orden de una
 * sola vez y cerrar la mano es instantáneo, mientras que escribir un código de
 * seis dígitos esperando 850 ms por tecla son cinco segundos de reloj. Una
 * pieza es lo contrario: está lejos, se apunta, y lo que conviene es que no
 * haga falta que se lea ningún gesto mientras se apunta.
 */
export const DWELL_MS = 850;

/**
 * Cuánto se puede salir la mano del eje del riel sin que este se suelte,
 * medido como fracción del largo del riel.
 *
 * Se mide perpendicular al riel y no sobre él: recorrerlo de punta a punta es
 * justo lo que se está haciendo, y pasarse del extremo no puede soltarlo.
 */
const ESCAPE_FRACTION = 0.4;

const plane = new Plane();
const hit = new Vector3();
const local = new Vector3();
const normal = new Vector3();
const quaternion = new Quaternion();

export class WidgetPointer {
  private dragging: Widget | null = null;
  private hovered: Widget | null = null;
  /** Desde cuándo se apunta a `hovered`. El contador. */
  private since = 0;
  /** Contra el repique: un control no se repite sin salir de él y volver. */
  private firedFor: string | null = null;
  private candidates: import("three").Object3D[] = [];
  /** Para pulsar en el flanco: ver el comentario en `update`. */
  private wasHolding = false;

  /**
   * Devuelve true si la mano está ocupada con la interfaz.
   *
   * Cuando lo está, la escena no debe mirar los objetos agarrables: cerrar la
   * mano sobre un deslizador no puede, además, llevarse un cubo de la mesa.
   */
  update(raycaster: Raycaster, now: number, holding: boolean, manos: boolean): boolean {
    // Cerrar la mano cuenta como pulsar, pero **solo en el instante en que se
    // cierra**. Si valiera el estado y no el flanco, barrer la fila de botones
    // con la mano ya cerrada los dispararía todos de paso.
    const press = holding && !this.wasHolding;
    this.wasHolding = holding;

    // **Con la mano, un riel enganchado se queda enganchado aunque la abras.**
    //
    // Es la única diferencia con el resto y es deliberada: un riel no se
    // *lleva*, se *ajusta*. Sostener la mano cerrada durante todo un recorrido
    // cansa el brazo y, peor, es lo que peor lee el detector -un pellizco
    // sostenido medio segundo se pierde un cuadro y el riel se soltaba solo a
    // mitad de camino. Enganchado, sigue la mano sin pedir nada, y se suelta
    // volviendo a cerrarla o saliéndose de su eje.
    //
    // `manos` es falso con mouse, y no es un capricho ni "otra interfaz para
    // cada experiencia": el enganche y el contador existen **para compensar un
    // gesto que no se puede sostener**, y un botón de mouse sí se sostiene.
    // Enganchando también ahí, el deslizador seguía al cursor con el botón
    // suelto y se movía solo al apartarse. La regla que ve quien lo usa es la
    // misma; lo que cambia es de qué está hecho "mantener".
    //
    // Mientras está enganchado no vuelve a probar contra nada: pasar por
    // delante de otro control mientras se ajusta este no lo roba.
    if (this.dragging) {
      const sigue = manos ? !press : holding;
      if (sigue && this.dragTo(raycaster)) return true;
      this.dragging = null;
      pointer.draggingId = null;
      return true;
    }

    const widget = this.pick(raycaster);
    if (widget !== this.hovered) {
      this.hovered = widget;
      this.since = now;
      this.firedFor = null;
    }

    if (!widget) {
      pointer.hoveredId = null;
      pointer.dwell = 0;
      return false;
    }
    pointer.hoveredId = widget.id;

    // El atajo: cerrar la mano hace lo mismo, ya.
    if (press) {
      this.firedFor = widget.id;
      pointer.dwell = 0;
      this.actuar(widget, raycaster);
      return true;
    }

    // **El contador, y vale para cualquier cosa que responda.**
    //
    // Esto estuvo solo en las piezas, con el argumento de que un botón se
    // pulsa cerrando la mano y escribir un código de seis dígitos esperando
    // 850 ms por tecla serían cinco segundos. El argumento sigue siendo
    // cierto y daba igual: **en el editor no hay piezas**, solo botones y
    // deslizadores, así que en toda esa pantalla el contador no aparecía
    // nunca y lo único que quedaba era el gesto que peor lee el detector. El
    // profesor se quedaba apuntando a un botón que no se pulsaba.
    //
    // Las dos vías hacen **lo mismo** en todas partes, que es lo que las hace
    // convivir: el contador es la que siempre funciona, cerrar la mano es la
    // que va rápida. El conflicto de antes era otro -el mismo gesto
    // significando cosas distintas según dónde cayera.
    if (!manos) {
      pointer.dwell = 0;
      return true;
    }
    const avance = this.firedFor === widget.id ? 0 : Math.min(1, (now - this.since) / DWELL_MS);
    pointer.dwell = avance;
    if (avance >= 1) {
      this.firedFor = widget.id;
      pointer.dwell = 0;
      this.actuar(widget, raycaster);
    }
    return true;
  }

  /** Lo que hace cada control: un botón se pulsa, un riel se engancha. */
  private actuar(widget: Widget, raycaster: Raycaster) {
    if (widget.kind === "slider") {
      this.dragging = widget;
      pointer.draggingId = widget.id;
      this.dragTo(raycaster);
    } else {
      widget.activate?.();
    }
  }

  /** Se llama al perder la mano: nada puede quedarse a medio arrastrar. */
  reset() {
    this.dragging = null;
    this.hovered = null;
    this.firedFor = null;
    this.wasHolding = false;
    pointer.hoveredId = null;
    pointer.dwell = 0;
    pointer.draggingId = null;
  }

  private pick(raycaster: Raycaster): Widget | null {
    this.candidates.length = 0;
    for (const widget of widgets.values()) {
      if (widget.object && !widget.disabled) this.candidates.push(widget.object);
    }
    if (this.candidates.length === 0) return null;

    const hit = raycaster.intersectObjects(this.candidates, false)[0];
    if (!hit) return null;
    pointer.distance = hit.distance;
    const id = hit.object.userData.widgetId as string | undefined;
    return id ? (widgets.get(id) ?? null) : null;
  }

  /**
   * Lleva el riel enganchado a donde apunta la mano.
   *
   * Devuelve si la mano sigue sobre el riel. Un `false` es la vía de escape:
   * el rayo se fue del plano del control o se salió demasiado de su eje.
   */
  private dragTo(raycaster: Raycaster): boolean {
    const widget = this.dragging;
    if (!widget?.object) return false;

    // El riel es un plano en el espacio: se cruza el rayo con él y se mira a
    // qué altura del riel cayó. Cruzar contra la malla en vez del plano haría
    // que el deslizador se soltara en cuanto la mano se saliera un poco.
    widget.object.getWorldPosition(hit);
    normal.set(0, 0, 1).applyQuaternion(widget.object.getWorldQuaternion(quaternion));
    plane.setFromNormalAndCoplanarPoint(normal, hit);
    if (!raycaster.ray.intersectPlane(plane, hit)) return false;

    widget.object.worldToLocal(local.copy(hit));
    if (Math.abs(local.y) > widget.length * ESCAPE_FRACTION) return false;

    const t = local.x / widget.length + 0.5;
    widget.drag?.(t < 0 ? 0 : t > 1 ? 1 : t);
    return true;
  }
}
