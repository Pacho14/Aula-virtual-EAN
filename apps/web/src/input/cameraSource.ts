/**
 * Fuente de entrada por camara: getUserMedia -> Web Worker -> InputFrame.
 *
 * El video nunca sale del dispositivo (seccion 13 del documento). Ni siquiera
 * sale del hilo principal: al worker va un ImageBitmap que se cierra apenas se
 * procesa, y de vuelta solo vienen coordenadas.
 */
import { API_BASE } from "../net/api";
import { emptyFrame, type HandFrame, type InputFrame, type InputSource } from "./types";
import type { WorkerHand } from "./handWorker";

/**
 * El runtime de MediaPipe lo sirve el servidor, no Vite: la libreria carga su
 * WASM con un import() dinamico y Vite rechaza importar archivos de su
 * carpeta public desde codigo fuente. La URL va absoluta para que el worker
 * la resuelva igual en desarrollo (dos puertos) y detras del tunel (uno solo).
 */
const WASM_PATH = import.meta.env.VITE_MEDIAPIPE_WASM ?? `${API_BASE}/mediapipe/wasm`;
const MODEL_PATH =
  import.meta.env.VITE_HAND_MODEL_URL ??
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/**
 * Ganancia del puntero: la zona comoda de la imagen (mas o menos el 55 %
 * central) cubre toda la pantalla. Sin esto hay que estirar el brazo hasta el
 * borde del cuadro, que es justo la fatiga que el documento marca como riesgo.
 */
const GAIN = 1.9;

export interface CameraOptions {
  /** Cuadros por segundo de deteccion. El documento fija 15-30. */
  targetFps?: number;
  onStatus?: (status: string) => void;
}

export class CameraSource implements InputSource {
  readonly kind = "camera" as const;

  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private running = false;
  private lastSent = 0;
  private frameHandle = 0;

  private frame: InputFrame = emptyFrame("camera");
  private detectTimes: number[] = [];
  private lastHandsAt = 0;

  constructor(private readonly options: CameraOptions = {}) {}

  async start() {
    const targetFps = this.options.targetFps ?? 24;
    this.options.onStatus?.("Pidiendo permiso de camara...");

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });

    const video = document.createElement("video");
    video.srcObject = this.stream;
    video.playsInline = true;
    video.muted = true;
    await video.play();
    this.video = video;

    this.options.onStatus?.("Cargando el detector de manos...");
    await this.startWorker("GPU");

    this.running = true;
    this.loop(targetFps);
  }

  private startWorker(delegate: "GPU" | "CPU") {
    return new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL("./handWorker.ts", import.meta.url), {
        type: "module",
      });
      this.worker = worker;

      worker.onmessage = (event) => {
        const data = event.data;
        if (data.type === "ready") {
          this.options.onStatus?.(`Detector listo (${data.delegate}).`);
          resolve();
          return;
        }
        if (data.type === "hands") {
          this.onHands(data.hands, data.timestamp);
          return;
        }
        if (data.type === "error") {
          if (!data.fatal && delegate === "GPU") {
            // Caida controlada a CPU: pasa en algunos navegadores moviles
            // donde el worker no puede abrir un contexto WebGL.
            this.options.onStatus?.("GPU no disponible, usando CPU.");
            worker.terminate();
            this.startWorker("CPU").then(resolve, reject);
          } else {
            reject(new Error(data.message));
          }
        }
      };

      worker.onerror = (event) => reject(new Error(event.message || "El worker fallo."));

      worker.postMessage({
        type: "init",
        wasmPath: WASM_PATH,
        modelPath: MODEL_PATH,
        delegate,
      });
    });
  }

  private loop(targetFps: number) {
    const minInterval = 1000 / targetFps;

    const pump = async () => {
      if (!this.running || !this.video || !this.worker) return;
      const now = performance.now();

      if (now - this.lastSent >= minInterval && this.video.readyState >= 2) {
        this.lastSent = now;
        try {
          // Se reduce a 320x240 antes de cruzar al worker: MediaPipe reescala
          // de todos modos y esto baja bastante el costo en celular.
          const bitmap = await createImageBitmap(this.video, {
            resizeWidth: 320,
            resizeHeight: 240,
            resizeQuality: "low",
          });
          this.worker.postMessage({ type: "frame", bitmap, timestamp: now }, [bitmap]);
        } catch {
          // Un cuadro perdido no es un error: puede pasar al rotar el telefono.
        }
      }

      this.frameHandle = requestAnimationFrame(pump);
    };

    this.frameHandle = requestAnimationFrame(pump);
  }

  private onHands(hands: WorkerHand[], timestamp: number) {
    this.detectTimes.push(timestamp);
    if (this.detectTimes.length > 20) this.detectTimes.shift();
    const span = this.detectTimes.at(-1)! - this.detectTimes[0]!;
    const detectFps = span > 0 ? Math.round(((this.detectTimes.length - 1) / span) * 1000) : 0;

    const left = hands.find((h) => h.handedness === "left");
    const right = hands.find((h) => h.handedness === "right");

    const leftFrame = left ? toHandFrame(left) : null;
    const rightFrame = right ? toHandFrame(right) : null;

    // La mano derecha manda si ambas estan visibles: es la que la mayoria usa
    // para senalar, y cambiar de mano a media sesion desorienta.
    this.frame = {
      source: "camera",
      left: leftFrame,
      right: rightFrame,
      primary: rightFrame ?? leftFrame,
      detectFps,
    };
    this.lastHandsAt = performance.now();
  }

  read(): InputFrame {
    // Si el detector se quedo sin manos, no hay que dejar el ultimo cuadro
    // congelado: el cursor quedaria pegado en el aire.
    if (this.frame.primary && performance.now() - this.lastHandsAt > 400) {
      this.frame = { ...emptyFrame("camera"), detectFps: this.frame.detectFps };
    }
    return this.frame;
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
    this.worker?.postMessage({ type: "stop" });
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video?.remove();
    this.video = null;
    this.frame = emptyFrame("camera");
  }
}

function toHandFrame(hand: WorkerHand): HandFrame {
  // Espejo en X para que mover la mano a la derecha mueva el cursor a la
  // derecha; sin esto la interaccion se siente invertida.
  const mirroredX = 1 - hand.px;
  return {
    handedness: hand.handedness,
    ndcX: clamp((mirroredX - 0.5) * 2 * GAIN, -1, 1),
    ndcY: clamp(-(hand.py - 0.5) * 2 * GAIN, -1, 1),
    rawY: hand.py,
    span: hand.span,
    gesture: hand.gesture,
    pinch: hand.pinch,
  };
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}
