/**
 * MediaPipe dentro de un Web Worker (seccion 10: "separado del hilo de render").
 *
 * El worker recibe un ImageBitmap por cuadro, corre la deteccion, clasifica el
 * gesto y suaviza el puntero. Al hilo principal salen el resultado y los 21
 * puntos de cada mano -63 numeros-, nunca el video: el ImageBitmap se cierra
 * aqui mismo en cuanto se procesa.
 *
 * De vuelta viaja tambien **cuanto costo la inferencia**. Con ese numero el
 * hilo principal regula cada cuanto manda un cuadro, que es como el detector
 * se adapta a un equipo lento sin tener una tabla de telefonos: la regla
 * entera esta en `CADENCE`, en cameraSource.ts.
 *
 * ## Que reloj se usa aqui
 *
 * Ninguno propio. `performance.now()` dentro de un worker cuenta desde que el
 * worker se creo, no desde el documento, asi que un instante medido aqui no se
 * puede comparar con uno medido alla. Por eso las marcas de tiempo que tocan
 * el filtrado **llegan desde el hilo principal** -son el instante real de
 * captura del cuadro- y lo unico que se mide aqui es una *duracion*, que si es
 * comparable porque es una diferencia.
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

/**
 * Umbrales de confianza del detector.
 *
 * Los tres no significan lo mismo, y el primero tiene una consecuencia que
 * costo encontrar: **`detection` es tambien la puerta por la que entra la
 * segunda mano.**
 *
 * - `detection` decide si aparece una mano que no se estaba siguiendo. Con una
 *   mano ya detectada, la otra tiene que cruzar este mismo umbral para
 *   existir. Subirlo a 0,65 -lo que estuvo aqui un rato, buscando menos falsos
 *   positivos- hacia que la segunda mano costara aparecer, y las dos manos no
 *   son un lujo de esta aplicacion: son requisito. Se queda en el medio.
 * - `presence` decide si la mano que ya se seguia sigue ahi. Tambien en el
 *   medio, y por la misma razon: subirlo suelta antes la mano que esta medio
 *   tapada por la otra, que es exactamente lo que pasa con dos manos a la vez.
 * - `tracking` decide si el seguimiento entre cuadros vale o hay que volver a
 *   correr el detector de palmas, que es la parte cara. Subirlo encarece la
 *   inferencia sin quitar un solo falso positivo, porque esta puerta solo se
 *   cruza con una mano ya aceptada.
 *
 * Contra los falsos positivos esta `GestureStabilizer`, que pide sostener el
 * gesto, y la ventana de perdida de cadence.ts. Esos dos filtran ruido sin
 * cerrarle la puerta a una mano de verdad.
 */
const CONFIDENCE = {
  detection: 0.5,
  presence: 0.5,
  tracking: 0.5,
} as const;

type InMessage =
  | {
      type: "init";
      wasmPath: string;
      modelPath: string;
      delegate: "GPU" | "CPU";
      /** Ancho/alto del cuadro que va a llegar. Lo necesita la profundidad. */
      aspect: number;
      numHands: number;
    }
  | {
      type: "frame";
      bitmap: ImageBitmap;
      /**
       * Instante **real de captura** del cuadro, en el reloj del hilo
       * principal. No es cuando se mando: ver `capturedAt` en cameraSource.ts.
       */
      capturedAt: number;
    }
  | { type: "stop" };

export interface WorkerHand {
  handedness: "left" | "right";
  /** Centro de la palma: lo que no se desplaza al cerrar la mano. */
  px: number;
  py: number;
  /**
   * Punta del indice. Con esto se apunta en todas partes -es el gesto natural
   * para señalar-, mientras que la palma manda en lo que hay que arrastrar sin
   * que tiemble: ver los rieles de la camara en CameraControls.
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
  | {
      type: "hands";
      hands: WorkerHand[];
      /** La marca de captura que llego con el cuadro, devuelta tal cual. */
      capturedAt: number;
      /** Lo que tardo `detectForVideo`, en milisegundos. Regula la cadencia. */
      cost: number;
      /** Cuantas manos esta buscando el detector ahora mismo. */
      numHands: number;
    };

declare function postMessage(message: OutMessage, transfer?: Transferable[]): void;

let landmarker: HandLandmarker | null = null;
let busy = false;
/** Ancho/alto del cuadro que manda el hilo principal. Lo fija `init`. */
let aspect = 4 / 3;
/**
 * Cuantas manos busca el detector. Lo fija `init` y no cambia: para buscar
 * otro numero se levanta un worker nuevo. Ver `build`.
 */
let numHands = 2;
/**
 * La ultima marca que vio MediaPipe.
 *
 * La libreria exige marcas estrictamente crecientes y dos capturas pueden
 * compartir milisegundo. Se empuja una hacia arriba solo para la libreria; el
 * filtrado sigue usando la de verdad.
 */
let lastTimestamp = 0;

const filters: Record<"left" | "right", HandFilter> = {
  left: new HandFilter(),
  right: new HandFilter(),
};
const stabilizers: Record<"left" | "right", GestureStabilizer> = {
  left: new GestureStabilizer(),
  right: new GestureStabilizer(),
};
let seen = { left: false, right: false };

/**
 * Crea el detector. **Una sola vez por worker**, y eso no es una limitacion
 * que se nos haya pasado por alto: es una de MediaPipe.
 *
 * Cerrar una tarea se lleva consigo el modulo WASM del worker, y crear una
 * segunda despues falla con "ModuleFactory not set" -tampoco sirve volver a
 * resolver el fileset, lo probamos. Lo tramposo es cuando se nota: a veces no
 * falla al crear sino en el primer cuadro, asi que todo parece haber ido bien
 * y lo que queda es un detector que no detecta.
 *
 * Por eso cambiar de configuracion -pasar a buscar una sola mano cuando el
 * equipo no da- se hace levantando un worker nuevo y tirando este. Lo decide
 * `degradeToOneHand` en cameraSource.ts, que explica lo que cuesta.
 */
async function build(wasmPath: string, modelPath: string, delegate: "GPU" | "CPU") {
  // El segundo argumento pide la variante ES module del runtime. Este worker
  // se crea con type: "module", asi que cargar la variante clasica no registra
  // la fabrica del modulo y MediaPipe falla con "ModuleFactory not set".
  const fileset = await FilesetResolver.forVisionTasks(wasmPath, true);
  landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelPath, delegate },
    runningMode: "VIDEO",
    numHands,
    minHandDetectionConfidence: CONFIDENCE.detection,
    minHandPresenceConfidence: CONFIDENCE.presence,
    minTrackingConfidence: CONFIDENCE.tracking,
  });
}

self.onmessage = async (event) => {
  const data = event.data;

  if (data.type === "init") {
    aspect = data.aspect;
    numHands = data.numHands;
    try {
      await build(data.wasmPath, data.modelPath, data.delegate);
      self.postMessage({ type: "ready", delegate: data.delegate });
    } catch (error) {
      // Ni el delegado GPU ni el modelo servido localmente existen siempre.
      // El hilo principal prueba la siguiente combinacion de su lista al ver
      // fatal: false; cual es la ultima lo decide alla, no aqui.
      self.postMessage({
        type: "error",
        message: String((error as Error)?.message ?? error),
        fatal: false,
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
      const timestamp = Math.max(data.capturedAt, lastTimestamp + 1);
      lastTimestamp = timestamp;

      // Lo unico que se mide con el reloj del worker, y se mide como
      // duracion: ver la nota sobre relojes en la cabecera.
      const startedAt = performance.now();
      const result = landmarker.detectForVideo(bitmap, timestamp);
      const cost = performance.now() - startedAt;

      // El filtrado va con la marca **real de captura**, no con la empujada:
      // el `dt` del filtro One Euro tiene que ser el que de verdad separa dos
      // cuadros, o el filtro cree que la mano se movio en otro tiempo del que
      // tardo y calcula mal la velocidad -que es justo lo que usa el hilo
      // principal para adelantar el puntero.
      const hands = toHands(result, data.capturedAt);

      // Los puntos viajan transferidos, no copiados: son 126 flotantes por
      // mano (imagen + mundo) y hasta 24 veces por segundo.
      postMessage(
        { type: "hands", hands, capturedAt: data.capturedAt, cost, numHands },
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
 * Cuanto se recuerda de que lado estaba una muñeca despues de perderla.
 *
 * En milisegundos y no en cuadros a proposito: la cadencia de inferencia ahora
 * se mueve entre 10 y 24 Hz segun lo que aguante el equipo, asi que "ocho
 * cuadros" -lo que decia antes- significaria 800 ms en un celular lento y
 * 330 ms en un portatil. Un umbral contado en cuadros es un umbral que cambia
 * de significado solo.
 */
const WRIST_MEMORY_MS = 350;

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
const wristSeenAt = { left: 0, right: 0 };

interface Candidate {
  index: number;
  x: number;
  y: number;
  raw: "left" | "right";
}

function assignSides(
  candidates: Candidate[],
  timestamp: number,
): Partial<Record<"left" | "right", number>> {
  const slots: Partial<Record<"left" | "right", number>> = {};
  const used = new Set<number>();

  // 1) La muñeca más cercana a donde estaba cada lado la última vez gana,
  // sin importar lo que diga la etiqueta de MediaPipe en este cuadro.
  for (const side of ["left", "right"] as const) {
    const prev = wristMemory[side];
    if (!prev || timestamp - wristSeenAt[side] > WRIST_MEMORY_MS) continue;
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
    const candidate =
      index !== undefined ? candidates.find((item) => item.index === index) : undefined;
    if (candidate) {
      wristMemory[side] = { x: candidate.x, y: candidate.y };
      wristSeenAt[side] = timestamp;
    } else if (timestamp - wristSeenAt[side] > WRIST_MEMORY_MS) {
      delete wristMemory[side];
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
    candidates.push({
      index: i,
      x: landmarks[0]!.x,
      y: landmarks[0]!.y,
      raw: raw === "Left" ? "left" : "right",
    });
  }

  const slots = assignSides(candidates, timestamp);
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
    const rawDistance = estimateCameraDistance(flat, flatWorld, aspect);
    // Un 0 significa "sin senal": no se mete en el filtro, o lo arrastraria
    // hasta cero y la mano se iria al tope de profundidad.
    const distance = rawDistance > 0 ? filter.distance.filter(rawDistance, timestamp) : 0;

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
      vdistance: rawDistance > 0 ? filter.distance.velocity : 0,
      gesture: stabilizers[handedness].push(c.gesture, timestamp),
      pinch: c.pinch,
      landmarks: flat,
      worldLandmarks: flatWorld,
    });
  }

  seen = present;
  return hands;
}
