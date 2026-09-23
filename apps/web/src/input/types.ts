/**
 * Capa de entrada abstracta (seccion 10 del documento).
 *
 * Todo dispositivo produce las mismas acciones. Nada aguas abajo de este
 * modulo sabe si el gesto vino de una camara, de un mouse o -en la fase 2-
 * del seguimiento nativo del Quest 3.
 */

export type Gesture = "none" | "point" | "pinch" | "fist" | "open";

/** Indices que viajan por la red. Coinciden con GESTURE en el servidor. */
export const GESTURE_INDEX: Record<Gesture, number> = {
  none: 0,
  point: 1,
  pinch: 2,
  fist: 3,
  open: 4,
};

export const GESTURE_LABEL: Record<Gesture, string> = {
  none: "sin gesto",
  point: "apuntar",
  pinch: "seleccionar",
  fist: "agarrar",
  open: "soltar",
};

export interface HandFrame {
  handedness: "left" | "right";
  /** Coordenadas normalizadas de dispositivo del puntero. -1..1 */
  ndcX: number;
  ndcY: number;
  /** Altura cruda en la imagen, 0 arriba y 1 abajo. Para "levantar la mano". */
  rawY: number;
  /** Tamano aparente de la palma: sirve de proxy de profundidad. */
  span: number;
  gesture: Gesture;
  /** 0 = abierto, 1 = pellizco completo. */
  pinch: number;
}

export interface InputFrame {
  source: "camera" | "mouse";
  /** La mano que manda el puntero. */
  primary: HandFrame | null;
  left: HandFrame | null;
  right: HandFrame | null;
  /** Cuadros por segundo de la deteccion, no del render. */
  detectFps: number;
}

export type InputAction = "select" | "grab" | "release" | "raiseHand" | "lowerHand";

export interface InputSource {
  readonly kind: "camera" | "mouse";
  start(): Promise<void>;
  stop(): void;
  /** Se lee en cada cuadro de render; no dispara renders de React. */
  read(): InputFrame;
}

export function emptyFrame(source: "camera" | "mouse"): InputFrame {
  return { source, primary: null, left: null, right: null, detectFps: 0 };
}
