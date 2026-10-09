/**
 * Fuente de entrada por camara: getUserMedia -> Web Worker -> InputFrame.
 *
 * El video nunca sale del dispositivo (seccion 13 del documento). Ni siquiera
 * sale del hilo principal: al worker va un ImageBitmap que se cierra apenas se
 * procesa, y de vuelta solo vienen coordenadas.
 *
 * ## Como se reparte el trabajo
 *
 * El reparto no es "todo al worker", porque no todo se puede ni conviene:
 *
 * - **Captura**: hilo principal. `createImageBitmap(video)` necesita el
 *   elemento `<video>`, que solo existe aqui. Es ademas lo unico barato de
 *   los tres pasos.
 * - **Inferencia, gestos y filtrado**: worker. Es el 90 % del costo y lo
 *   unico que de verdad tumbaria los cuadros del render.
 * - **Resultado**: transferido, no copiado. Los 126 flotantes por mano viajan
 *   como buffers cedidos (ver `postMessage` en handWorker.ts), asi que cruzar
 *   el limite no cuesta una copia.
 * - **Adelanto y dibujo**: hilo principal, en cada cuadro de render. Tiene
 *   que ir al ritmo de la pantalla, no al del detector.
 *
 * ## Los dos ritmos
 *
 * La inferencia **no va al ritmo del render ni al de la camara**. Va a la
 * cadencia que decida `CADENCE` a partir de lo que cuesta de verdad una
 * inferencia en este equipo, y el render dibuja a 60 adelantando la ultima
 * medicion. Bajar la cadencia no añade retraso: cada inferencia se corre
 * sobre el cuadro **recien llegado**, asi que lo unico que baja es cada
 * cuanto se refresca, no cuanto tarda en llegar.
 */
import { API_BASE } from "../net/api";
import { CADENCE, cadenceFor, leadScale, lostWindowMs, predictSeconds } from "./cadence";
import { emptyFrame, type HandFrame, type InputFrame, type InputSource } from "./types";
import type { WorkerHand } from "./handWorker";

/**
 * El runtime de MediaPipe lo sirve el servidor, no Vite: la libreria carga su
 * WASM con un import() dinamico y Vite rechaza importar archivos de su
 * carpeta public desde codigo fuente. La URL va absoluta para que el worker
 * la resuelva igual en desarrollo (dos puertos) y detras del tunel (uno solo).
 */
const WASM_PATH = import.meta.env.VITE_MEDIAPIPE_WASM ?? `${API_BASE}/mediapipe/wasm`;

/**
 * El modelo, servido desde el propio origen y con el CDN de Google solo como
 * respaldo.
 *
 * Son 7,5 MB que antes se bajaban del CDN en cada arranque en frio. En el wifi
 * de un campus eso es el primer cuello de toda la experiencia, y en una red
 * que filtre dominios externos no arranca en absoluto -el mismo motivo por el
 * que el WASM ya se servia de aqui (ver scripts/vendor-mediapipe.mjs, que
 * ahora tambien trae el modelo).
 *
 * El respaldo existe porque el archivo lo deja un script de instalacion: un
 * clon que haya instalado sin red no lo tiene, y mas vale que arranque lento
 * que no arranque.
 */
const MODEL_LOCAL = `${API_BASE}/mediapipe/model/hand_landmarker.task`;
const MODEL_CDN =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/**
 * En que orden se intenta arrancar el detector.
 *
 * Dos cosas pueden fallar y son independientes: el delegado GPU no siempre
 * existe dentro de un worker -pasa en algunos navegadores moviles, que no
 * pueden abrir un contexto WebGL ahi- y el modelo local puede no estar. Se
 * recorre la lista hasta que una combinacion arranque.
 */
const ATTEMPTS: ReadonlyArray<{ modelPath: string; delegate: "GPU" | "CPU" }> = (
  import.meta.env.VITE_HAND_MODEL_URL
    ? [import.meta.env.VITE_HAND_MODEL_URL as string]
    : [MODEL_LOCAL, MODEL_CDN]
).flatMap((modelPath) => [
  { modelPath, delegate: "GPU" as const },
  { modelPath, delegate: "CPU" as const },
]);

/**
 * Tamano al que se reduce el cuadro antes de cruzar al worker.
 *
 * MediaPipe reescala a esto de todos modos -su modelo de puntos trabaja a
 * 224x224-, asi que pedir la camara mas grande solo mueve el costo de
 * reescalar al hilo principal, cada cuadro. Subirlo **no arregla** una mano
 * que no se detecta: lo que falla ahi es la luz o el encuadre, no los
 * pixeles. La proporcion viaja al worker porque la estimacion de profundidad
 * la necesita: X e Y vienen normalizados a lados distintos (ver handSpace.ts).
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
 * Las dos manos se buscan siempre, y eso no se negocia por rendimiento.
 *
 * Aqui hubo un segundo escalon de degradacion: cuando la cadencia llevaba un
 * rato clavada en su piso, el detector pasaba a buscar **una sola mano**.
 * Ahorraba de verdad -una pasada entera del modelo de puntos cuando hay dos
 * manos a la vista- y esta quitado de todos modos, porque chocaba con un
 * requisito de la experiencia: las dos manos tienen que funcionar. Un ahorro
 * que apaga una funcion no es una degradacion elegante, es una funcion menos,
 * y encima se encendia sola en el equipo de quien menos lo esperaba.
 *
 * Lo que queda regulando es la cadencia, que es ademas de donde salia casi
 * todo el ahorro: bajar de 30 a 10 Hz es dos tercios menos de inferencias.
 */
const BOTH_HANDS = 2;

/** Si el worker no contesta en este plazo, el cuadro se dio por perdido. */
const STUCK_MS = 1000;

export interface CameraOptions {
  onStatus?: (status: string) => void;
}

/** Lo que se puede mirar para saber por que la mano va como va. */
export interface CameraDiagnostics {
  /** Cuadros por segundo de deteccion, medidos. */
  detectFps: number;
  /** A cuantos apunta el regulador ahora mismo. */
  cadenceHz: number;
  /** Lo que cuesta una inferencia en este equipo, en ms. */
  costMs: number;
  /**
   * Cuanto tarda un cuadro desde que la camara lo captura hasta que su
   * resultado esta disponible aqui. Es el retraso que el adelanto cancela.
   */
  latencyMs: number;
  numHands: number;
  delegate: "GPU" | "CPU" | null;
  /** Si la marca de tiempo es la real de captura o una estimada. */
  timedByCamera: boolean;
}

/**
 * `requestVideoFrameCallback` no esta en la definicion estandar de TS aun.
 *
 * De su metadata interesan dos campos, y los dos son del mismo reloj que
 * `performance.now()`: `captureTime`, el instante en que la camara capturo el
 * cuadro -lo que de verdad se quiere-, y `presentationTime`, cuando el cuadro
 * quedo listo para componerse, que es el respaldo cuando el primero no viene.
 */
interface VideoFrameMetadata {
  presentationTime?: number;
  expectedDisplayTime?: number;
  captureTime?: number;
  mediaTime?: number;
}

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameMetadata) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export class CameraSource implements InputSource {
  readonly kind = "camera" as const;

  private video: VideoWithFrameCallback | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private running = false;
  private lastSent = 0;
  /** Handle de rAF o de requestVideoFrameCallback, segun cual se use. */
  private frameHandle = 0;
  private usingFrameCallback = false;
  /**
   * El cuadro de camara nuevo sin procesar, y cuando se capturo de verdad.
   *
   * Con `requestVideoFrameCallback` esto solo se enciende cuando la camara
   * entrega un cuadro nuevo, asi que no se gasta nada creando ImageBitmaps del
   * mismo cuadro dos veces -que es lo que hacia el bucle anterior, atado al
   * refresco de la pantalla y no al de la camara.
   */
  private pending: { capturedAt: number } | null = null;
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
  /**
   * Cuando se **capturo** el cuadro del que salio eso. Mismo reloj que
   * performance.now(). No es cuando llego ni cuando se mando: de la diferencia
   * entre esto y ahora sale cuanto hay que adelantar.
   */
  private sampledAt = 0;
  private detectFps = 0;
  private detectTimes: number[] = [];
  private lastHandsAt = 0;

  // --- regulador ----------------------------------------------------------
  private cadenceHz: number = CADENCE.startHz;
  /** Media movil de lo que cuesta una inferencia. Un pico suelto no manda. */
  private costMs = 0;
  private latencyMs = 0;
  private numHands = BOTH_HANDS;
  private delegate: "GPU" | "CPU" | null = null;

  // --- guardia de frenada -------------------------------------------------
  /** Recorte del adelanto por mano. 1 = se adelanta todo lo que se pueda. */
  private lead = { left: 1, right: 1 };
  private lastSpeed = { left: 0, right: 0 };

  constructor(private readonly options: CameraOptions = {}) {}

  async start() {
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
    await this.startWorker();

    this.running = true;
    this.schedule();
  }

  /** Recorre `ATTEMPTS` hasta que una combinacion arranque. */
  private async startWorker() {
    let last: Error | null = null;
    for (const attempt of ATTEMPTS) {
      try {
        await this.tryWorker(attempt.modelPath, attempt.delegate);
        this.delegate = attempt.delegate;
        return;
      } catch (error) {
        last = error as Error;
      }
    }
    throw last ?? new Error("No se pudo arrancar el detector de manos.");
  }

  private tryWorker(modelPath: string, delegate: "GPU" | "CPU") {
    return new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL("./handWorker.ts", import.meta.url), {
        type: "module",
      });
      this.worker = worker;
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        reject(error);
      };

      worker.onmessage = (event) => {
        const data = event.data;
        if (data.type === "ready") {
          if (settled) return;
          settled = true;
          this.options.onStatus?.(`Detector listo (${data.delegate}).`);
          resolve();
          return;
        }
        if (data.type === "hands") {
          this.onHands(data.hands, data.capturedAt, data.cost, data.numHands);
          // El worker quedo libre. Si mientras trabajaba llego un cuadro de
          // camara nuevo, sale ya: esperar al siguiente tic del reloj era
          // hasta un refresco entero de retraso por cada deteccion.
          this.inFlight = false;
          this.drain();
          return;
        }
        if (data.type === "error") {
          // Antes de arrancar, un error descarta esta combinacion y se prueba
          // la siguiente. Despues, un error suelto en una inferencia no tira
          // el detector: se pierde ese cuadro y sigue.
          if (!settled) {
            fail(new Error(data.message));
            return;
          }
          this.inFlight = false;
          console.warn("[manos] el detector fallo en un cuadro:", data.message);
        }
      };

      worker.onerror = (event) => fail(new Error(event.message || "El worker fallo."));

      worker.postMessage({
        type: "init",
        wasmPath: WASM_PATH,
        modelPath,
        delegate,
        aspect: CAPTURE_WIDTH / CAPTURE_HEIGHT,
        numHands: this.numHands,
      });
    });
  }

  /**
   * Pide avisos de cuadro de camara.
   *
   * `requestVideoFrameCallback` avisa una vez por cuadro de la camara, que es
   * exactamente cuando hay algo nuevo que detectar, y **de paso dice cuando se
   * capturo**. Eso segundo es lo que hace honesto el adelanto: con el reloj de
   * cuando se manda al worker, la exposicion y la cola de la camara quedan
   * fuera de la cuenta y el retraso medido sale menor que el real, asi que el
   * adelanto corrige de menos.
   *
   * El respaldo por requestAnimationFrame existe para los navegadores que no
   * traen el aviso. Ahi no hay marca de captura: se usa la de ahora, que es lo
   * que habia antes, y `timedByCamera` lo dice para que no se confunda una
   * medicion con la otra.
   */
  private schedule() {
    const video = this.video;
    if (!this.running || !video) return;

    if (typeof video.requestVideoFrameCallback === "function") {
      this.usingFrameCallback = true;
      this.frameHandle = video.requestVideoFrameCallback((now, metadata) => {
        if (!this.running) return;
        // `captureTime` es el instante real; `presentationTime` es el respaldo
        // razonable. Los dos son del reloj de `performance.now()`. El tope con
        // `now` es por si un navegador entregara algo del futuro: un retraso
        // negativo haria que el adelanto fuera hacia atras.
        const capturedAt = Math.min(metadata.captureTime ?? metadata.presentationTime ?? now, now);
        this.pending = { capturedAt };
        this.drain();
        this.schedule();
      });
      return;
    }

    this.usingFrameCallback = false;
    this.frameHandle = requestAnimationFrame(() => {
      if (!this.running) return;
      this.pending = { capturedAt: performance.now() };
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
    const pending = this.pending;
    if (!pending || video.readyState < 2) return;

    // La cadencia, y ahora si en las dos ramas. Antes esta linea solo valia en
    // el respaldo por rAF, asi que en la rama normal -la que corre- no habia
    // tope ninguno: se inferia al ritmo de la camara, 30 Hz, en cualquier
    // equipo. Saltarse un cuadro aqui no añade retraso, porque el que se
    // procesa despues es el recien llegado, no el que se dejo pasar.
    if (now - this.lastSent < 1000 / this.cadenceHz) return;

    this.pending = null;
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
        this.worker.postMessage({ type: "frame", bitmap, capturedAt: pending.capturedAt }, [
          bitmap,
        ]);
      })
      .catch(() => {
        // Un cuadro perdido no es un error: puede pasar al rotar el telefono.
        this.inFlight = false;
      });
  }

  private onHands(hands: WorkerHand[], capturedAt: number, cost: number, numHands: number) {
    const now = performance.now();

    this.detectTimes.push(now);
    if (this.detectTimes.length > 20) this.detectTimes.shift();
    const span = this.detectTimes.at(-1)! - this.detectTimes[0]!;
    this.detectFps = span > 0 ? Math.round(((this.detectTimes.length - 1) / span) * 1000) : 0;

    this.numHands = numHands;
    this.regulate(cost, now - capturedAt);

    // El recorte del adelanto, mano por mano. Se calcula aqui -una vez por
    // deteccion- y no en `read`, que corre en cada cuadro de render.
    const present = { left: false, right: false };
    for (const hand of hands) {
      present[hand.handedness] = true;
      const speed = Math.hypot(hand.vx, hand.vy);
      const previous = this.lastSpeed[hand.handedness];
      this.lastSpeed[hand.handedness] = speed;
      this.lead[hand.handedness] = leadScale(previous, speed);
    }
    // Una mano que vuelve no hereda la frenada de la ultima vez que se vio.
    for (const side of ["left", "right"] as const) {
      if (present[side]) continue;
      this.lead[side] = 1;
      this.lastSpeed[side] = 0;
    }

    this.hands = hands;
    this.sampledAt = capturedAt;
    this.lastHandsAt = now;
  }

  /** Ajusta la cadencia a lo que cuesta de verdad una inferencia aqui. */
  private regulate(cost: number, latency: number) {
    this.costMs = blend(this.costMs, cost);
    this.latencyMs = blend(this.latencyMs, latency);
    this.cadenceHz = cadenceFor(this.costMs).hz;
  }

  /** Cuanto se aguanta sin manos antes de apagar el puntero. */
  private get lostMs() {
    return lostWindowMs(this.cadenceHz);
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

  get diagnostics(): CameraDiagnostics {
    return {
      detectFps: this.detectFps,
      cadenceHz: Math.round(this.cadenceHz),
      costMs: Math.round(this.costMs),
      latencyMs: Math.round(this.latencyMs),
      numHands: this.numHands,
      delegate: this.delegate,
      timedByCamera: this.usingFrameCallback,
    };
  }

  read(): InputFrame {
    const now = performance.now();

    // Si el detector se quedo sin manos, no hay que dejar el ultimo cuadro
    // congelado: la mano quedaria sostenida en una pose que ya no existe, que
    // es peor que no dibujar nada.
    if (this.hands.length > 0 && now - this.lastHandsAt > this.lostMs) {
      this.hands = [];
      this.lead = { left: 1, right: 1 };
      this.lastSpeed = { left: 0, right: 0 };
    }
    if (this.hands.length === 0) {
      return { ...emptyFrame("camera"), detectFps: this.detectFps };
    }

    // Cuanto lleva de viejo el cuadro que se va a dibujar, **contado desde su
    // captura**. De ahi sale cuanto se adelanta la mano.
    const age = now - this.sampledAt;

    let left: HandFrame | null = null;
    let right: HandFrame | null = null;
    for (const hand of this.hands) {
      const projected = toHandFrame(hand, predictSeconds(age, this.lead[hand.handedness]));
      if (hand.handedness === "left") left = projected;
      else right = projected;
    }

    // La mano derecha manda si ambas estan visibles: es la que la mayoria usa
    // para senalar, y cambiar de mano a media sesion desorienta.
    return {
      source: "camera",
      left,
      right,
      primary: right ?? left,
      detectFps: this.detectFps,
      sampledAt: this.sampledAt,
    };
  }

  stop() {
    this.running = false;
    this.inFlight = false;
    this.pending = null;
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

/**
 * Media movil suave, donde una muestra mala no envenena la media.
 *
 * Lo primero es para que un cuadro caro suelto -una pestaña que vuelve del
 * fondo, un recolector de basura- no mueva la cadencia. Lo segundo es porque
 * una media movil es un acumulador: si entra un NaN una sola vez, **se queda
 * para siempre**, y entonces la cadencia deja de regularse sin que nada falle
 * de forma visible. Una muestra que no es un numero se descarta y la media
 * sigue con lo que tenia.
 */
function blend(previous: number, sample: number) {
  if (!Number.isFinite(sample)) return previous;
  return previous === 0 ? sample : previous * 0.8 + sample * 0.2;
}
