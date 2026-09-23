/**
 * Clasificacion de gestos a partir de los 21 puntos de MediaPipe.
 *
 * Se hacen a mano en vez de usar GestureRecognizer porque el documento fija
 * cinco gestos concretos (seccion 10) y conviene controlar los umbrales: el
 * reconocedor generico trae gestos que aqui no significan nada y cuesta mas.
 *
 * Corre dentro del Web Worker, asi que los 21 puntos nunca cruzan al hilo
 * principal: solo sale el resultado, unos pocos numeros.
 */
import type { Gesture } from "./types";

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_PIP = 10;
const MIDDLE_TIP = 12;
const RING_PIP = 14;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_PIP = 18;
const PINKY_TIP = 20;

export interface Classified {
  gesture: Gesture;
  pinch: number;
  /** Ancho aparente de la palma en coordenadas normalizadas. */
  span: number;
  /** Centro de la palma: estable en todos los gestos. */
  px: number;
  py: number;
}

export function classify(lm: Landmark[]): Classified {
  // El centro de la palma, y no la punta del indice, es el origen del
  // puntero: no se desplaza al cerrar el puno, asi que el objeto no salta
  // en el instante de agarrarlo.
  const px = (lm[WRIST]!.x + lm[INDEX_MCP]!.x + lm[MIDDLE_MCP]!.x + lm[PINKY_MCP]!.x) / 4;
  const py = (lm[WRIST]!.y + lm[INDEX_MCP]!.y + lm[MIDDLE_MCP]!.y + lm[PINKY_MCP]!.y) / 4;

  // Todo se normaliza contra el tamano de la palma, para que el gesto se
  // lea igual con la mano cerca o lejos de la camara.
  const span = Math.max(dist(lm[WRIST]!, lm[MIDDLE_MCP]!), 1e-5);

  const pinchDist = dist(lm[THUMB_TIP]!, lm[INDEX_TIP]!) / span;
  const pinch = clamp01(1 - (pinchDist - 0.35) / 0.6);
  const indexReach = dist(lm[INDEX_TIP]!, lm[WRIST]!) / span;

  const extended = [
    isExtended(lm, INDEX_PIP, INDEX_TIP),
    isExtended(lm, MIDDLE_PIP, MIDDLE_TIP),
    isExtended(lm, RING_PIP, RING_TIP),
    isExtended(lm, PINKY_PIP, PINKY_TIP),
  ];
  const count = extended.filter(Boolean).length;

  let gesture: Gesture = "none";
  if (pinchDist < 0.45 && indexReach > 1.45) {
    // Pulgar e indice juntos, pero con el indice estirado: es pellizco y no
    // puno. Sin la segunda condicion un puno se lee como pellizco.
    gesture = "pinch";
  } else if (count === 0) {
    gesture = "fist";
  } else if (count >= 4) {
    gesture = "open";
  } else if (extended[0] && count <= 2) {
    gesture = "point";
  }

  return { gesture, pinch, span, px, py };
}

function isExtended(lm: Landmark[], pip: number, tip: number) {
  // Un dedo estirado pone la punta mas lejos de la muneca que su nudillo
  // medio. El 8 % de margen es la histeresis basica contra el ruido.
  return dist(lm[tip]!, lm[WRIST]!) > dist(lm[pip]!, lm[WRIST]!) * 1.08;
}

function dist(a: Landmark, b: Landmark) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Histeresis temporal: un gesto solo se acepta despues de repetirse varios
 * cuadros seguidos. Sin esto, un cuadro con ruido dispara un clic falso.
 */
export class GestureStabilizer {
  private candidate: Gesture = "none";
  private streak = 0;
  private committed: Gesture = "none";

  constructor(private readonly frames = 3) {}

  push(gesture: Gesture): Gesture {
    if (gesture === this.candidate) {
      this.streak += 1;
    } else {
      this.candidate = gesture;
      this.streak = 1;
    }
    if (this.streak >= this.frames) this.committed = this.candidate;
    return this.committed;
  }

  reset() {
    this.candidate = "none";
    this.committed = "none";
    this.streak = 0;
  }
}
