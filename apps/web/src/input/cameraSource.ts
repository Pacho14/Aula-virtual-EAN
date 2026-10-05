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
  /**
   * Hay un cuadro en vuelo hacia el worker.
   *
   * El worker procesa de a uno y descarta lo que llegue mientras trabaja, asi
   * que mandarle cuadros a ciegas solo gasta el hilo principal creando
   * ImageBitmaps que se van a tirar. Esperar a que conteste y mandar el
   * siguiente de inmediato da la cadencia mas rapida posible sin desperdicio,
   * y sobre todo sin el tope artificial que habia antes.
   */
  private inFlight = false;
  private inFlightAt = 0;

  private frame: InputFrame = emptyFrame("camera");
  private detectTimes: number[] = [];
  private lastHandsAt = 0;

  constructor(private readonly options: CameraOptions = {}) {}

  async start() {
    const targetFps = this.options.targetFps ?? 60;
    this.options.onStatus?.("Pidiendo permiso de camara...");

    // Se pide ya a 320x240: MediaPipe reescala a eso de todos modos (ver
    // `loop` mas abajo), asi que pedirla mas grande solo mueve el costo de
    // reescalar del hilo principal... al hilo principal, cada cuadro.
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 240 } },
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
          // El worker quedo libre: el bucle puede mandarle el siguiente
          // cuadro en el acto, sin esperar ningun reloj.
          this.inFlight = false;
          this.onHands(data.hands, data.timestamp);
          return;
        }
        if (data.type === "error") {
          this.inFlight = false;
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
    /** Si el worker no contesta en este plazo, el cuadro se dio por perdido. */
    const STUCK_MS = 1000;

    const pump = () => {
      // Se agenda el siguiente cuadro ANTES de hacer nada. Antes esto estaba
      // al final de una funcion `async` que esperaba a `createImageBitmap`,
      // asi que la cadencia de captura quedaba atada a cuanto tardara crear
      // el bitmap en vez de al refresco de la pantalla.
      this.frameHandle = requestAnimationFrame(pump);
      if (!this.running || !this.video || !this.worker) return;
      const now = performance.now();

      if (this.inFlight) {
        if (now - this.inFlightAt < STUCK_MS) return;
        this.inFlight = false;
      }
      // El tope por fps queda como piso de seguridad, no como regulador: el
      // que marca el ritmo es el worker, que pide el siguiente cuadro en
      // cuanto termina el anterior.
      if (now - this.lastSent < minInterval || this.video.readyState < 2) return;

      this.lastSent = now;
      this.inFlight = true;
      this.inFlightAt = now;
      // Se reduce a 320x240 antes de cruzar al worker: MediaPipe reescala
      // de todos modos y esto baja bastante el costo en celular.
      createImageBitmap(this.video, { resizeWidth: 320, resizeHeight: 240, resizeQuality: "low" })
        .then((bitmap) => {
          if (!this.running || !this.worker) {
            bitmap.close();
            this.inFlight = false;
            return;
          }
          this.worker.postMessage({ type: "frame", bitmap, timestamp: now }, [bitmap]);
        })
        .catch(() => {
          // Un cuadro perdido no es un error: puede pasar al rotar el telefono.
          this.inFlight = false;
        });
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

  /**
   * El elemento de video, para quien quiera dibujarlo localmente (la vista
   * de depuracion). Sigue sin salir del dispositivo: esto no manda nada por
   * la red, solo expone la referencia que ya existe para pintarla en un
   * canvas que solo el propio usuario ve.
   */
  get videoElement(): HTMLVideoElement | null {
    return this.video;
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
    this.inFlight = false;
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
  const mirroredIndexX = 1 - hand.ipx;
  return {
    handedness: hand.handedness,
    ndcX: clamp((mirroredX - 0.5) * 2 * GAIN, -1, 1),
    ndcY: clamp(-(hand.py - 0.5) * 2 * GAIN, -1, 1),
    indexNdcX: clamp((mirroredIndexX - 0.5) * 2 * GAIN, -1, 1),
    indexNdcY: clamp(-(hand.ipy - 0.5) * 2 * GAIN, -1, 1),
    rawY: hand.py,
    span: hand.span,
    gesture: hand.gesture,
    pinch: hand.pinch,
    landmarks: hand.landmarks,
    worldLandmarks: hand.worldLandmarks,
  };
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}
