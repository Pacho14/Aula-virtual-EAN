/**
 * MediaPipe dentro de un Web Worker (seccion 10: "separado del hilo de render").
 *
 * El worker recibe un ImageBitmap por cuadro, corre la deteccion, clasifica el
 * gesto y suaviza el puntero. Al hilo principal solo salen unos pocos numeros
 * por mano, nunca los 21 puntos ni el video.
 */
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { classify, GestureStabilizer, type Landmark } from "./gestures";
import { HandFilter } from "./oneEuro";
import type { Gesture } from "./types";

declare const self: {
  onmessage: ((event: MessageEvent<InMessage>) => void) | null;
  postMessage: (message: OutMessage) => void;
};

type InMessage =
  | { type: "init"; wasmPath: string; modelPath: string; delegate: "GPU" | "CPU" }
  | { type: "frame"; bitmap: ImageBitmap; timestamp: number }
  | { type: "stop" };

export interface WorkerHand {
  handedness: "left" | "right";
  px: number;
  py: number;
  span: number;
  gesture: Gesture;
  pinch: number;
}

type OutMessage =
  | { type: "ready"; delegate: "GPU" | "CPU" }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "hands"; hands: WorkerHand[]; timestamp: number };

let landmarker: HandLandmarker | null = null;
let busy = false;

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
      self.postMessage({
        type: "hands",
        hands: toHands(result, data.timestamp),
        timestamp: data.timestamp,
      });
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

function toHands(
  result: { landmarks: Landmark[][]; handedness: { categoryName: string }[][] },
  timestamp: number,
): WorkerHand[] {
  const hands: WorkerHand[] = [];
  const present = { left: false, right: false };

  for (let i = 0; i < result.landmarks.length; i++) {
    const landmarks = result.landmarks[i];
    if (!landmarks || landmarks.length < 21) continue;

    // MediaPipe rotula la mano desde el punto de vista de la imagen. Como el
    // video se muestra en espejo, hay que invertirlo para que coincida con la
    // mano que el estudiante siente que esta moviendo.
    const raw = result.handedness[i]?.[0]?.categoryName ?? "Right";
    const handedness: "left" | "right" = raw === "Left" ? "right" : "left";
    if (present[handedness]) continue;
    present[handedness] = true;

    const c = classify(landmarks);
    const filter = filters[handedness];
    if (!seen[handedness]) {
      filter.reset();
      stabilizers[handedness].reset();
    }

    hands.push({
      handedness,
      px: filter.x.filter(c.px, timestamp),
      py: filter.y.filter(c.py, timestamp),
      span: filter.span.filter(c.span, timestamp),
      gesture: stabilizers[handedness].push(c.gesture),
      pinch: c.pinch,
    });
  }

  seen = present;
  return hands;
}
