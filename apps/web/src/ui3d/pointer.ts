/**
 * El puntero contra la interfaz espacial.
 *
 * Un botón pensado para hand tracking no se pulsa como uno de mouse. La mano
 * tiembla, el pellizco a veces no se lee, y exigir un gesto exacto convierte
 * cada clic en un forcejeo. Aquí hay dos caminos a la vez para lo mismo:
 *
 *   - pellizcar, que es inmediato cuando el detector lo ve bien;
 *   - sostener la mano encima algo menos de un segundo, que no depende de
 *     ningún gesto y siempre funciona.
 *
 * El anillo que se va llenando alrededor del cursor es lo que hace que la
 * segunda vía se entienda sin explicarla.
 */
import { Plane, Quaternion, Vector3, type Raycaster } from "three";
import { pointer, widgets, type Widget } from "./widgets";

/** Cuánto hay que sostener la mano encima de un botón para que se active. */
export const DWELL_MS = 850;

const plane = new Plane();
const hit = new Vector3();
const local = new Vector3();
const normal = new Vector3();
const quaternion = new Quaternion();

export class WidgetPointer {
  private hovered: Widget | null = null;
  private since = 0;
  /** Contra el repique: un botón no se vuelve a disparar sin salir de él. */
  private firedFor: string | null = null;
  private dragging: Widget | null = null;
  private candidates: import("three").Object3D[] = [];
  /** Para pulsar en el flanco: ver el comentario en `update`. */
  private wasHolding = false;

  /**
   * Devuelve true si la mano está ocupada con la interfaz.
   *
   * Cuando lo está, la escena no debe mirar los objetos agarrables: cerrar el
   * puño sobre un deslizador no puede, además, llevarse un cubo de la mesa.
   */
  update(
    raycaster: Raycaster,
    now: number,
    holding: boolean,
    select: boolean,
    allowDwell: boolean,
  ): boolean {
    // Cerrar la mano cuenta como pulsar, pero solo en el instante en que se
    // cierra. Si valiera el estado y no el flanco, barrer la fila de botones
    // con el puño ya cerrado los dispararía todos de paso; y sin esto, con
    // mouse habría que quedarse quieto casi un segundo sobre cada botón.
    const press = holding && !this.wasHolding;
    this.wasHolding = holding;

    if (this.dragging) {
      if (!holding) {
        this.dragging = null;
        pointer.draggingId = null;
      } else {
        this.dragTo(raycaster);
        return true;
      }
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

    if (widget.kind === "slider") {
      if (holding) {
        pointer.dwell = 0;
        this.dragging = widget;
        pointer.draggingId = widget.id;
        this.dragTo(raycaster);
        return true;
      }

      // Espera sostenida sobre el riel: apuntar y quedarse quieto lleva el
      // deslizador a donde se apunta, igual que sobre un boton o una pieza.
      // Antes esto era la unica cosa de la interfaz que exigia un gesto si o
      // si -habia que cerrar la mano para arrastrarlo-, y un gesto es justo
      // lo que peor se lee cuando el detector va lento.
      if (!allowDwell) {
        pointer.dwell = 0;
        return true;
      }
      const dwell = Math.min(1, (now - this.since) / DWELL_MS);
      pointer.dwell = dwell;
      if (dwell >= 1) {
        this.dragTo(raycaster);
        // Se rearma en vez de bloquearse con `firedFor`: un deslizador se
        // ajusta varias veces seguidas, al reves que un boton, que no debe
        // dispararse solo una y otra vez mientras se le mira.
        this.since = now;
        pointer.dwell = 0;
      }
      return true;
    }

    // Pellizcar o cerrar la mano pulsa siempre, aunque sea el mismo boton que
    // la vez anterior: un codigo con dos digitos iguales seguidos se escribe
    // pulsando dos veces sin mover la mano, y con el guardia de repique
    // puesto la segunda pulsacion no llegaba nunca.
    if (select || press) {
      this.firedFor = widget.id;
      this.since = now;
      pointer.dwell = 0;
      widget.activate?.();
      return true;
    }

    // En modo mouse/toque el click ya pulsa (arriba): quedarse quieto encima
    // de un boton no debe pulsarlo tambien, o un clic real se confunde con
    // simplemente apuntar. Esto queda solo para camara, donde no hay click.
    if (!allowDwell) {
      pointer.dwell = 0;
      return true;
    }

    // La espera sostenida si lleva guardia: si no, quedarse mirando un boton
    // lo dispararia una vez por segundo. Para repetir por esta via hay que
    // salir y volver.
    const dwell = Math.min(1, (now - this.since) / DWELL_MS);
    pointer.dwell = dwell;
    if (dwell >= 1 && this.firedFor !== widget.id) {
      this.firedFor = widget.id;
      pointer.dwell = 0;
      widget.activate?.();
    }
    return true;
  }

  /** Se llama al perder la mano: nada puede quedarse a medio arrastrar. */
  reset() {
    this.hovered = null;
    this.dragging = null;
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

  private dragTo(raycaster: Raycaster) {
    const widget = this.dragging;
    if (!widget?.object) return;

    // El riel es un plano en el espacio: se cruza el rayo con él y se mira a
    // qué altura del riel cayó. Cruzar contra la malla en vez del plano haría
    // que el deslizador se soltara en cuanto la mano se saliera un poco.
    widget.object.getWorldPosition(hit);
    normal.set(0, 0, 1).applyQuaternion(widget.object.getWorldQuaternion(quaternion));
    plane.setFromNormalAndCoplanarPoint(normal, hit);
    if (!raycaster.ray.intersectPlane(plane, hit)) return;

    widget.object.worldToLocal(local.copy(hit));
    const t = local.x / widget.length + 0.5;
    widget.drag?.(t < 0 ? 0 : t > 1 ? 1 : t);
  }
}
