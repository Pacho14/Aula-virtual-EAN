/**
 * MediaPipe dentro de un Web Worker (seccion 10: "separado del hilo de render").
 *
 * El worker recibe un ImageBitmap por cuadro, corre la deteccion, clasifica el
 * gesto y suaviza el puntero. Al hilo principal salen el resultado y los 21
 * puntos de cada mano -63 numeros-, nunca el video: el ImageBitmap se cierra
 * aqui mismo en cuanto se procesa.
 */
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { classify, GestureStabilizer, type Landmark } from "./gestures";
import { estimateCameraDistance } from "./handSpace";
import { HandFilter } from "./oneEuro";
import type { Gesture } from "./types";

declare const self: {
  onmessage: ((event: MessageEvent<InMessage>) => void) | null;
  postMessage: (message: OutMessage) => void;
};

type InMessage =
  | {
      type: "init";
      wasmPath: string;
      modelPath: string;
      delegate: "GPU" | "CPU";
      /** Ancho/alto del cuadro que va a llegar. Lo necesita la profundidad. */
      aspect: number;
    }
  | { type: "frame"; bitmap: ImageBitmap; timestamp: number }
  | { type: "stop" };

export interface WorkerHand {
  handedness: "left" | "right";
  /** Centro de la palma: el origen del puntero dentro del salon. */
  px: number;
  py: number;
  /**
   * Punta del indice. El lobby apunta con esto -es el gesto natural para
   * señalar un portal-, mientras que dentro del salon manda la palma, que no
   * se desplaza al cerrar el puño para agarrar algo.
   */
  ipx: number;
  ipy: number;
  /** Distancia a la webcam en metros, o 0 si no se pudo estimar. */
  distance: number;
  /**
   * Velocidades de los cuatro valores de arriba, en unidades por segundo, y
   * de la distancia en metros por segundo.
   *
   * Las calcula el filtro One Euro de paso, y viajan para que el hilo
   * principal pueda adelantar la posicion por lo que lleve de retraso el
   * cuadro. Sin esto el cursor va siempre una deteccion por detras de la
   * mano, que es el retraso que mas se nota de toda la experiencia.
   */
  vx: number;
  vy: number;
  vix: number;
  viy: number;
  vdistance: number;
  gesture: Gesture;
  pinch: number;
  /** Los 21 puntos en crudo de MediaPipe, normalizados a la imagen: x, y, z por punto. */
  landmarks: Float32Array;
  /**
   * Los mismos 21 puntos, pero en `worldLandmarks`: metros reales relativos a
   * la muñeca, con la proporcion de la mano ya resuelta por el modelo. Para
   * dibujar la forma de la mano en 3D esto es lo que hay que usar -no las
   * coordenadas de imagen-, porque su escala no depende de que tan cerca este
   * la mano de la camara ni de el angulo en que este girada.
   */
  worldLandmarks: Float32Array;
}

type OutMessage =
  | { type: "ready"; delegate: "GPU" | "CPU" }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "hands"; hands: WorkerHand[]; timestamp: number };

declare function postMessage(message: OutMessage, transfer?: Transferable[]): void;

let landmarker: HandLandmarker | null = null;
let busy = false;
/** Ancho/alto del cuadro que manda el hilo principal. Lo fija `init`. */
let aspect = 4 / 3;

const filters: Record<"left" | "right", HandFilter> = {
  left: new HandFilter(),
  right: new HandFilter(),
};
const stabilizers: Record<"left" | "right", GestureStabilizer> = {
  left: new GestureStabilizer(),
  right: new GestureStabilizer(),
};
let seen = { left: false, right: false };

self.onmessage = async (event) => {
  const data = event.data;

  if (data.type === "init") {
    aspect = data.aspect;
    try {
      // El segundo argumento pide la variante ES module del runtime. Este
      // worker se crea con type: "module", asi que cargar la variante clasica
      // no registra la fabrica del modulo y MediaPipe falla con
      // "ModuleFactory not set".
      const fileset = await FilesetResolver.forVisionTasks(data.wasmPath, true);
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: data.modelPath, delegate: data.delegate },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      self.postMessage({ type: "ready", delegate: data.delegate });
    } catch (error) {
      // El delegado GPU no siempre existe dentro de un worker. El hilo
      // principal reintenta con CPU al ver fatal: false.
      self.postMessage({
        type: "error",
        message: String((error as Error)?.message ?? error),
        fatal: data.delegate === "CPU",
      });
    }
    return;
  }

  if (data.type === "stop") {
    landmarker?.close();
    landmarker = null;
    return;
  }

  if (data.type === "frame") {
    const bitmap = data.bitmap;
    if (!landmarker || busy) {
      bitmap.close();
      return;
    }
    busy = true;
    try {
      const result = landmarker.detectForVideo(bitmap, data.timestamp);
      const hands = toHands(result, data.timestamp);
      // Los puntos viajan transferidos, no copiados: son 126 flotantes por
      // mano (imagen + mundo) y hasta 24 veces por segundo.
      postMessage(
        { type: "hands", hands, timestamp: data.timestamp },
        hands.flatMap((hand) => [hand.landmarks.buffer, hand.worldLandmarks.buffer]),
      );
    } catch (error) {
      self.postMessage({
        type: "error",
        message: String((error as Error)?.message ?? error),
        fatal: false,
      });
    } finally {
      bitmap.close();
      busy = false;
    }
  }
};

/**
 * A que lado pertenecia la muñeca que estaba en cada posicion, cuadro a
 * cuadro. MediaPipe decide "Left"/"Right" mano por mano y por cuadro, sin
 * memoria: una mano en un angulo ambiguo puede cambiar de etiqueta de un
 * cuadro al siguiente aunque sea la misma mano, sin haberse movido. Preferir
 * la muñeca mas cercana a donde estaba cada lado la ultima vez evita ese
 * intercambio -el mismo mecanismo que ya prueba quien escribio esto en otro
 * proyecto.
 */
const wristMemory: { left?: { x: number; y: number }; right?: { x: number; y: number } } = {};
const wristLost = { left: 0, right: 0 };

interface Candidate {
  index: number;
  x: number;
  y: number;
  raw: "left" | "right";
}

function assignSides(candidates: Candidate[]): Partial<Record<"left" | "right", number>> {
  const slots: Partial<Record<"left" | "right", number>> = {};
  const used = new Set<number>();

  // 1) La muñeca más cercana a donde estaba cada lado la última vez gana,
  // sin importar lo que diga la etiqueta de MediaPipe en este cuadro.
  for (const side of ["left", "right"] as const) {
    const prev = wristMemory[side];
    if (!prev || wristLost[side] > 8) continue;
    let best = -1;
    let bestDistance = 0.2;
    for (const candidate of candidates) {
      if (used.has(candidate.index)) continue;
      const distance = Math.hypot(candidate.x - prev.x, candidate.y - prev.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate.index;
      }
    }
    if (best >= 0) {
      slots[side] = best;
      used.add(best);
    }
  }

  // 2) Lo que sobra y todavia no tiene lado, a su propia etiqueta cruda.
  for (const candidate of candidates) {
    if (used.has(candidate.index) || slots[candidate.raw] !== undefined) continue;
    slots[candidate.raw] = candidate.index;
    used.add(candidate.index);
  }

  // 3) Lo que sobra de verdad -dos manos con la misma etiqueta cruda-, al
  // lado que siga libre.
  for (const candidate of candidates) {
    if (used.has(candidate.index)) continue;
    const other: "left" | "right" = candidate.raw === "left" ? "right" : "left";
    if (slots[other] !== undefined) continue;
    slots[other] = candidate.index;
    used.add(candidate.index);
  }

  for (const side of ["left", "right"] as const) {
    const index = slots[side];
    const candidate = index !== undefined ? candidates.find((item) => item.index === index) : undefined;
    if (candidate) {
      wristMemory[side] = { x: candidate.x, y: candidate.y };
      wristLost[side] = 0;
    } else {
      wristLost[side] += 1;
      if (wristLost[side] > 8) delete wristMemory[side];
    }
  }

  return slots;
}

function toHands(
  result: {
    landmarks: Landmark[][];
    worldLandmarks: Landmark[][];
    handedness: { categoryName: string }[][];
  },
  timestamp: number,
): WorkerHand[] {
  const candidates: Candidate[] = [];
  for (let i = 0; i < result.landmarks.length; i++) {
    const landmarks = result.landmarks[i];
    if (!landmarks || landmarks.length < 21) continue;
    // La captura nunca se espeja antes de llegar aqui (cameraSource.ts manda
    // el cuadro crudo), asi que MediaPipe ve la mano tal cual es y su
    // "Left"/"Right" ya coincide con la mano real de quien la mueve -esta
    // etiqueta cruda es solo el punto de partida; `assignSides` decide.
    const raw = result.handedness[i]?.[0]?.categoryName ?? "Right";
    candidates.push({ index: i, x: landmarks[0]!.x, y: landmarks[0]!.y, raw: raw === "Left" ? "left" : "right" });
  }

  const slots = assignSides(candidates);
  const present = { left: slots.left !== undefined, right: slots.right !== undefined };
  const hands: WorkerHand[] = [];

  for (const handedness of ["left", "right"] as const) {
    const i = slots[handedness];
    if (i === undefined) continue;
    const landmarks = result.landmarks[i]!;
    const world = result.worldLandmarks[i];
    if (!world || world.length < 21) continue;

    const c = classify(landmarks);
    const filter = filters[handedness];
    if (!seen[handedness]) {
      filter.reset();
      stabilizers[handedness].reset();
    }

    const flat = new Float32Array(21 * 3);
    const flatWorld = new Float32Array(21 * 3);
    for (let p = 0; p < 21; p++) {
      const point = landmarks[p]!;
      flat[p * 3] = point.x;
      flat[p * 3 + 1] = point.y;
      flat[p * 3 + 2] = point.z;
      const worldPoint = world[p]!;
      flatWorld[p * 3] = worldPoint.x;
      flatWorld[p * 3 + 1] = worldPoint.y;
      flatWorld[p * 3 + 2] = worldPoint.z;
    }

    // 8 es INDEX_FINGER_TIP en la numeracion de MediaPipe (ver LANDMARKS).
    const indexTip = landmarks[8]!;

    // La profundidad se estima sobre los 21 puntos ya aplanados: compara el
    // tamano aparente en la imagen contra el tamano real en metros, asi que
    // no se mueve al girar la mano. La cuenta esta en handSpace.ts.
    const raw = estimateCameraDistance(flat, flatWorld, aspect);
    // Un 0 significa "sin senal": no se mete en el filtro, o lo arrastraria
    // hasta cero y la mano se iria al tope de profundidad.
    const distance = raw > 0 ? filter.distance.filter(raw, timestamp) : 0;

    hands.push({
      handedness,
      px: filter.x.filter(c.px, timestamp),
      py: filter.y.filter(c.py, timestamp),
      ipx: filter.ix.filter(indexTip.x, timestamp),
      ipy: filter.iy.filter(indexTip.y, timestamp),
      distance,
      vx: filter.x.velocity,
      vy: filter.y.velocity,
      vix: filter.ix.velocity,
      viy: filter.iy.velocity,
      vdistance: raw > 0 ? filter.distance.velocity : 0,
      gesture: stabilizers[handedness].push(c.gesture),
      pinch: c.pinch,
      landmarks: flat,
      worldLandmarks: flatWorld,
    });
  }

  seen = present;
  return hands;
}
