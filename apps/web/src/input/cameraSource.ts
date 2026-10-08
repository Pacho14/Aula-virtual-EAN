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
 * Tamano al que se reduce el cuadro antes de cruzar al worker.
 *
 * MediaPipe reescala a esto de todos modos, asi que pedir la camara mas
 * grande solo mueve el costo de reescalar al hilo principal, cada cuadro. La
 * proporcion viaja al worker porque la estimacion de profundidad la necesita:
 * X e Y vienen normalizados a lados distintos (ver handSpace.ts).
 */
const CAPTURE_WIDTH = 320;
const CAPTURE_HEIGHT = 240;

/**
 * Ganancia del puntero: la zona comoda de la imagen (mas o menos el 55 %
 * central) cubre toda la pantalla. Sin esto hay que estirar el brazo hasta el
 * borde del cuadro, que es justo la fatiga que el documento marca como riesgo.
 */
const GAIN = 1.9;

/**
 * Cuanto se permite adelantar la posicion de la mano, en milisegundos.
 *
 * El cuadro que se esta dibujando se capturo hace un rato: entre la captura,
 * la deteccion y el mensaje de vuelta pasan facil 100 ms, y durante todo ese
 * tiempo el cursor dibuja donde estaba la mano, no donde esta. Adelantar por
 * la velocidad que ya calcula el filtro cancela ese retraso en vez de solo
 * reducirlo, y no cuesta nada: con la mano quieta la velocidad es cero y no
 * se adelanta nada, asi que no añade temblor.
 *
 * El tope existe porque la velocidad va suavizada y por tanto llega tarde a
 * los cambios de sentido: adelantar mas de esto hace que el cursor se pase de
 * largo al frenar y vuelva. 90 ms es aproximadamente una deteccion a 12 Hz.
 */
const PREDICT_MS = 90;

/** Si el worker no contesta en este plazo, el cuadro se dio por perdido. */
const STUCK_MS = 1000;

/** Sin manos durante esto, el cursor se apaga en vez de quedarse pegado. */
const LOST_MS = 400;

export interface CameraOptions {
  /** Tope de cuadros por segundo de deteccion. El documento fija 15-30. */
  targetFps?: number;
  onStatus?: (status: string) => void;
}

/** `requestVideoFrameCallback` no esta en la definicion estandar de TS aun. */
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export class CameraSource implements InputSource {
  readonly kind = "camera" as const;

  private video: VideoWithFrameCallback | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private running = false;
  private lastSent = 0;
  private minInterval = 0;
  /** Handle de rAF o de requestVideoFrameCallback, segun cual se use. */
  private frameHandle = 0;
  private usingFrameCallback = false;
  /**
   * Hay un cuadro de camara nuevo sin procesar.
   *
   * Con `requestVideoFrameCallback` esto solo se enciende cuando la camara
   * entrega de verdad un cuadro nuevo, asi que no se gasta nada creando
   * ImageBitmaps del mismo cuadro dos veces -que es lo que hacia el bucle
   * anterior, atado al refresco de la pantalla y no al de la camara.
   */
  private pendingFrame = false;
  /**
   * Hay un cuadro en vuelo hacia el worker.
   *
   * El worker procesa de a uno y descarta lo que llegue mientras trabaja, asi
   * que mandarle cuadros a ciegas solo gasta el hilo principal creando
   * ImageBitmaps que se van a tirar.
   */
  private inFlight = false;
  private inFlightAt = 0;

  /** Lo ultimo que contesto el worker, sin adelantar: `read` lo adelanta. */
  private hands: WorkerHand[] = [];
  /** Cuando se capturo ese cuadro. Misma reloj que performance.now(). */
  private sampledAt = 0;
  private detectFps = 0;
  private detectTimes: number[] = [];
  private lastHandsAt = 0;

  constructor(private readonly options: CameraOptions = {}) {}

  async start() {
    this.minInterval = 1000 / (this.options.targetFps ?? 60);
    this.options.onStatus?.("Pidiendo permiso de camara...");

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: CAPTURE_WIDTH },
        height: { ideal: CAPTURE_HEIGHT },
      },
      audio: false,
    });

    const video = document.createElement("video") as VideoWithFrameCallback;
    video.srcObject = this.stream;
    video.playsInline = true;
    video.muted = true;
    await video.play();
    this.video = video;

    this.options.onStatus?.("Cargando el detector de manos...");
    await this.startWorker("GPU");

    this.running = true;
    this.schedule();
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
          // El worker quedo libre. Si mientras trabajaba llego un cuadro de
          // camara nuevo, sale ya: esperar al siguiente tic del reloj era
          // hasta un refresco entero de retraso por cada deteccion.
          this.inFlight = false;
          this.drain();
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
        aspect: CAPTURE_WIDTH / CAPTURE_HEIGHT,
      });
    });
  }

  /**
   * Pide avisos de cuadro de camara.
   *
   * `requestVideoFrameCallback` avisa una vez por cuadro de la camara, que es
   * exactamente cuando hay algo nuevo que detectar. El respaldo por
   * requestAnimationFrame existe para los navegadores que no lo traen, y ahi
   * si hay que mirar el reloj para no procesar el mismo cuadro dos veces.
   */
  private schedule() {
    const video = this.video;
    if (!this.running || !video) return;

    if (typeof video.requestVideoFrameCallback === "function") {
      this.usingFrameCallback = true;
      this.frameHandle = video.requestVideoFrameCallback(() => {
        if (!this.running) return;
        this.pendingFrame = true;
        this.drain();
        this.schedule();
      });
      return;
    }

    this.usingFrameCallback = false;
    this.frameHandle = requestAnimationFrame(() => {
      if (!this.running) return;
      this.pendingFrame = true;
      this.drain();
      this.schedule();
    });
  }

  /** Manda al worker el cuadro pendiente, si puede y si hay. */
  private drain() {
    const video = this.video;
    if (!this.running || !video || !this.worker) return;
    const now = performance.now();

    if (this.inFlight) {
      if (now - this.inFlightAt < STUCK_MS) return;
      this.inFlight = false;
    }
    if (!this.pendingFrame || video.readyState < 2) return;
    // El tope por fps es un piso de seguridad, no el regulador: el ritmo lo
    // marcan la camara y el worker. Con avisos de cuadro de camara, el propio
    // ritmo de la camara ya es el tope.
    if (!this.usingFrameCallback && now - this.lastSent < this.minInterval) return;

    this.pendingFrame = false;
    this.lastSent = now;
    this.inFlight = true;
    this.inFlightAt = now;
    createImageBitmap(video, {
      resizeWidth: CAPTURE_WIDTH,
      resizeHeight: CAPTURE_HEIGHT,
      resizeQuality: "low",
    })
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
  }

  private onHands(hands: WorkerHand[], timestamp: number) {
    this.detectTimes.push(timestamp);
    if (this.detectTimes.length > 20) this.detectTimes.shift();
    const span = this.detectTimes.at(-1)! - this.detectTimes[0]!;
    this.detectFps = span > 0 ? Math.round(((this.detectTimes.length - 1) / span) * 1000) : 0;

    this.hands = hands;
    this.sampledAt = timestamp;
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
    const now = performance.now();
    if (this.hands.length > 0 && now - this.lastHandsAt > LOST_MS) this.hands = [];
    if (this.hands.length === 0) {
      return { ...emptyFrame("camera"), detectFps: this.detectFps };
    }

    // Cuanto lleva de viejo el cuadro que se va a dibujar. Es lo que se
    // adelanta la mano, acotado por PREDICT_MS.
    const age = Math.min(Math.max(now - this.sampledAt, 0), PREDICT_MS) / 1000;

    let left: HandFrame | null = null;
    let right: HandFrame | null = null;
    for (const hand of this.hands) {
      const projected = toHandFrame(hand, age);
      if (hand.handedness === "left") left = projected;
      else right = projected;
    }

    // La mano derecha manda si ambas estan visibles: es la que la mayoria usa
    // para senalar, y cambiar de mano a media sesion desorienta.
    return { source: "camera", left, right, primary: right ?? left, detectFps: this.detectFps };
  }

  stop() {
    this.running = false;
    this.inFlight = false;
    this.pendingFrame = false;
    if (this.usingFrameCallback) this.video?.cancelVideoFrameCallback?.(this.frameHandle);
    else cancelAnimationFrame(this.frameHandle);
    this.worker?.postMessage({ type: "stop" });
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video?.remove();
    this.video = null;
    this.hands = [];
  }
}

/**
 * De lo que contesto el worker al cuadro que lee la escena, adelantando la
 * posicion por `age` segundos.
 *
 * El giro en X no es un espejo: es la mitad del giro de 180° que separa el
 * punto de vista de la webcam -que esta enfrente mirando a quien usa esto- del
 * punto de vista de sus propios ojos. Por eso mover la mano a la derecha mueve
 * el cursor a la derecha. El giro completo, su determinante y por que negar
 * tambien Z lo convertiria en una reflexion de verdad estan en handSpace.ts,
 * que es quien gira la forma de la mano con los mismos signos.
 */
function toHandFrame(hand: WorkerHand, age: number): HandFrame {
  const px = hand.px + hand.vx * age;
  const py = hand.py + hand.vy * age;
  const ipx = hand.ipx + hand.vix * age;
  const ipy = hand.ipy + hand.viy * age;
  // Una mano que se acerca rapido puede quedar con la distancia adelantada por
  // debajo de cero, y un cero significa "sin senal": la mano daria un salto a
  // su profundidad de reposo en medio del movimiento. El piso es absurdamente
  // cerca, asi que solo lo toca una prediccion desbocada.
  const distance =
    hand.distance > 0 ? Math.max(hand.distance + hand.vdistance * age, 0.05) : 0;

  return {
    handedness: hand.handedness,
    ndcX: clamp((1 - px - 0.5) * 2 * GAIN, -1, 1),
    ndcY: clamp(-(py - 0.5) * 2 * GAIN, -1, 1),
    indexNdcX: clamp((1 - ipx - 0.5) * 2 * GAIN, -1, 1),
    indexNdcY: clamp(-(ipy - 0.5) * 2 * GAIN, -1, 1),
    rawY: py,
    cameraDistance: distance,
    gesture: hand.gesture,
    pinch: hand.pinch,
    landmarks: hand.landmarks,
    worldLandmarks: hand.worldLandmarks,
  };
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}
