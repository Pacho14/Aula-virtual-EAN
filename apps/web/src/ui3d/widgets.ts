/**
 * Registro de controles que la mano puede tocar.
 *
 * Mismo patrón que `grabbables` en scene/registry.ts y por la misma razón: el
 * rayo del puntero se lanza en cada cuadro y no debe recorrer el árbol de
 * React para saber contra qué probar. Hay un solo editor vivo a la vez.
 */
import { useCallback, useRef } from "react";
import type { Camera, Object3D } from "three";

export type WidgetKind = "button" | "slider";

export interface Widget {
  id: string;
  kind: WidgetKind;
  object: Object3D | null;
  disabled: boolean;
  /** Botones: pellizco, o mano sostenida encima. */
  activate?(): void;
  /** Deslizadores: posición normalizada sobre el riel, de 0 a 1. */
  drag?(t: number): void;
  /** Largo del riel en metros. Convierte el punto tocado en esa posición. */
  length: number;
}

export const widgets = new Map<string, Widget>();

/**
 * Lo que el puntero está haciendo con la interfaz, para que los controles se
 * dibujen en consecuencia sin que nada de esto pase por el estado de React.
 */
export const pointer = {
  hoveredId: null as string | null,
  /** Avance de la espera sostenida sobre un botón, de 0 a 1. */
  dwell: 0,
  /** Deslizador que la mano tiene tomado ahora mismo. */
  draggingId: null as string | null,
  /** A qué distancia tocó el rayo. La escena pone ahí el cursor. */
  distance: 0,
};

export interface WidgetHandlers {
  activate?(): void;
  drag?(t: number): void;
  disabled?: boolean;
  /** Solo deslizadores. */
  length?: number;
}

/**
 * Engancha una malla al registro.
 *
 * Los manejadores se refrescan en cada render sobre el mismo registro, en vez
 * de volver a registrarlo: así el botón nunca llama a una versión vieja de su
 * propia acción, que es el error clásico de guardar closures en un mapa.
 */
export function useWidget(id: string, kind: WidgetKind, handlers: WidgetHandlers) {
  const record = useRef<Widget>({ id, kind, object: null, disabled: false, length: 1 });

  record.current.activate = handlers.activate;
  record.current.drag = handlers.drag;
  record.current.disabled = handlers.disabled ?? false;
  record.current.length = handlers.length ?? 1;

  return useCallback(
    (object: Object3D | null) => {
      if (object) {
        object.userData.widgetId = id;
        record.current.object = object;
        widgets.set(id, record.current);
      } else {
        widgets.delete(id);
      }
    },
    [id],
  );
}

/**
 * Sonda para la prueba de navegador. Solo en desarrollo.
 *
 * Una interfaz dibujada dentro del lienzo no tiene nodos del DOM que pulsar,
 * así que sin esto la prueba tendría que barrer la pantalla a ciegas buscando
 * botones, tardando un minuto y pulsando por accidente los que encuentra de
 * paso. La sonda proyecta cada control a coordenadas de pantalla y ya.
 */
export function exposeWidgetProbe(camera: Camera, objects: Map<string, Object3D>) {
  if (!import.meta.env.DEV) return;
  const win = window as unknown as Record<string, unknown>;

  const place = (object: Object3D) => {
    const point = camera.position.clone();
    object.getWorldPosition(point);
    const world = { x: point.x, y: point.y, z: point.z };
    point.project(camera);

    // Si esta colgado del arbol de la escena. Una malla desprendida sigue
    // respondiendo al rayo y sigue diciendo donde esta, pero no se dibuja: es
    // exactamente el sintoma de "el puntero la encuentra y no se ve".
    let root: Object3D | null = object;
    let depth = 0;
    while (root.parent) {
      root = root.parent;
      depth += 1;
    }

    // Tamano real de la geometria. Una malla con la caja a cero responde al
    // rayo por su esfera envolvente pero no pinta un solo pixel.
    const mesh = object as Object3D & {
      geometry?: {
        boundingBox: { min: { x: number }; max: { x: number } } | null;
        computeBoundingBox(): void;
      };
    };
    let size = -1;
    if (mesh.geometry) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (box) size = box.max.x - box.min.x;
    }

    return {
      world,
      x: (point.x * 0.5 + 0.5) * window.innerWidth,
      y: (-point.y * 0.5 + 0.5) * window.innerHeight,
      visible: object.visible,
      attached: depth > 0 && root.type === "Scene",
      scale: object.scale.x,
      size,
      // Un NaN en la matriz deja al objeto en la escena, en su sitio y con su
      // malla, dibujandose en cada cuadro sin pintar un pixel. Es invisible
      // para cualquier prueba que solo mire posiciones, asi que se comprueba.
      finite: object.matrixWorld.elements.every((n) => Number.isFinite(n)),
    };
  };

  win.__aulaWidgets = () => {
    const out: Record<string, { x: number; y: number }> = {};
    for (const [id, widget] of widgets) {
      if (!widget.object || widget.disabled) continue;
      out[id] = place(widget.object);
    }
    return out;
  };

  // Las piezas de la escena, para que la prueba pueda comprobar que lo que el
  // rayo encuentra es lo mismo que se ve, y no algo escondido dentro la mesa.
  win.__aulaObjetos = () => {
    const out: Record<string, unknown> = {};
    for (const [id, object] of objects) out[id] = place(object);
    return out;
  };
}

/** Se llama al salir del editor: nada debe sobrevivir a la sala. */
export function clearWidgets() {
  widgets.clear();
  pointer.hoveredId = null;
  pointer.dwell = 0;
  pointer.draggingId = null;
}
