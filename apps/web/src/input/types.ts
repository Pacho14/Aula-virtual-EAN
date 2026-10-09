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
  pinch: "tomar",
  fist: "agarrar",
  open: "soltar",
};

/**
 * Los gestos con los que se **tiene** algo: el puño y el pellizco.
 *
 * Viven juntos aquí porque lo que importa de ellos es justo lo que comparten.
 * Pasar de uno al otro es cambiar de agarre, no soltar: quien cierra el puño
 * sobre una pieza y luego la pellizca sigue teniéndola. Lo que suelta es salir
 * de los dos -abrir la mano, o que el detector la pierda a media maniobra.
 *
 * Antes solo el puño contaba, así que el pellizco no podía sostener nada: era
 * un pulso para pulsar botones y se acababa ahí. Ahora pellizcar es la vía
 * rápida para tomar una pieza -ver `PINCH_HOLD_MS` en LocalPlayer-, y para que
 * eso funcione, soltar el pellizco tiene que soltar la pieza.
 *
 * Lo leen la capa de entrada, que decide cuándo emitir `release`, y la escena,
 * que decide si abrir la mano ya puede soltar. Tenerlo escrito dos veces sería
 * tenerlo distinto en cuanto alguien tocara uno de los dos.
 */
export const HOLD_GESTURES: ReadonlySet<Gesture> = new Set<Gesture>(["fist", "pinch"]);

/**
 * Si pasar de un gesto al siguiente es **abrir la mano**, que es lo que suelta.
 *
 * Es una línea, y está aquí como función con nombre en vez de incrustada en la
 * capa de entrada porque es **la** regla de la que depende que una pieza se
 * caiga a medio camino, y es exactamente la clase de cosa que se rompe sin que
 * ninguna prueba de posición se entere: la pieza aparece en el suelo y parece
 * que falló el imán, o el servidor, o la red.
 *
 * Es el **flanco**, no el estado: lo que suelta es el gesto de abrir, no estar
 * abierto. Importa porque una pieza se toma con el contador **apuntando**, y
 * apuntar es la mano casi abierta: si contara el estado, la pieza se caería en
 * el mismo instante de tomarla. Abriendo del todo -los cinco dedos- sí hay
 * flanco, y eso es un gesto que nadie hace sin querer.
 */
export function opensHand(previous: Gesture, next: Gesture): boolean {
  return next === "open" && previous !== "open";
}

/**
 * Los 21 puntos de MediaPipe, en su orden y con sus nombres.
 *
 * Es el sistema de MediaPipe tal cual, sin renumerar: cualquier cosa que se
 * lea sobre Hand Landmarker vale directamente para este código.
 */
export const LANDMARKS = [
  "WRIST",
  "THUMB_CMC",
  "THUMB_MCP",
  "THUMB_IP",
  "THUMB_TIP",
  "INDEX_FINGER_MCP",
  "INDEX_FINGER_PIP",
  "INDEX_FINGER_DIP",
  "INDEX_FINGER_TIP",
  "MIDDLE_FINGER_MCP",
  "MIDDLE_FINGER_PIP",
  "MIDDLE_FINGER_DIP",
  "MIDDLE_FINGER_TIP",
  "RING_FINGER_MCP",
  "RING_FINGER_PIP",
  "RING_FINGER_DIP",
  "RING_FINGER_TIP",
  "PINKY_MCP",
  "PINKY_PIP",
  "PINKY_DIP",
  "PINKY_TIP",
] as const;

export const LANDMARK_COUNT = LANDMARKS.length;

/** Qué punto se une con cuál para dibujar el esqueleto de la mano. */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export interface HandFrame {
  handedness: "left" | "right";
  /**
   * Coordenadas normalizadas de dispositivo del puntero. -1..1
   *
   * Salen del centro de la palma: es lo que no se desplaza al cerrar el puño,
   * así que el objeto que se agarra no salta en el instante de tomarlo. Es el
   * puntero del salón de clases.
   */
  ndcX: number;
  ndcY: number;
  /**
   * Lo mismo, pero desde la punta del índice.
   *
   * El lobby apunta con esto: señalar un portal con el dedo es el gesto que
   * la gente hace sola, y ahí no hay nada que agarrar, así que el salto de la
   * punta al cerrar la mano no importa.
   */
  indexNdcX: number;
  indexNdcY: number;
  /** Altura cruda en la imagen, 0 arriba y 1 abajo. Para "levantar la mano". */
  rawY: number;
  /**
   * Distancia de la mano a la webcam, en metros. 0 si no se pudo estimar.
   *
   * Sale de comparar el tamaño aparente de la mano en la imagen contra su
   * tamaño real en `worldLandmarks`, así que no cambia al girar la mano -el
   * defecto que tenía medirla con una sola distancia 2D. Es lo que le da
   * profundidad a la mano dentro de la escena: acercarla a la webcam es
   * alejarla de los propios ojos, así que la mano se adentra. La cuenta y el
   * porqué del signo están en `handSpace.ts`.
   */
  cameraDistance: number;
  gesture: Gesture;
  /** 0 = abierto, 1 = pellizco completo. */
  pinch: number;
  /**
   * Los 21 puntos en crudo, tres números por punto: x, y, z.
   *
   * x e y son coordenadas normalizadas de la imagen de la cámara -0 arriba a
   * la izquierda, 1 abajo a la derecha-, y z es profundidad relativa a la
   * muñeca, como los entrega MediaPipe. Sin espejo y sin ganancia: quien los
   * use decide cómo llevarlos a su sistema.
   *
   * Hasta la fase 2 estos puntos no salían del worker. Ahora sí, porque hacen
   * falta para dibujar la mano y para calibrar. El vídeo sigue sin salir del
   * dispositivo: lo que cruza son 63 números por mano.
   */
  landmarks: Float32Array | null;
  /**
   * Los mismos 21 puntos en `worldLandmarks`: metros reales relativos a la
   * muñeca, con la proporción de la mano ya resuelta por MediaPipe. Para
   * dibujar la forma de la mano en 3D es esto lo que hay que usar, no
   * `landmarks` -que es normalizado a la imagen y se encoge o se infla según
   * qué tan cerca esté la mano de la cámara o cómo esté girada.
   */
  worldLandmarks: Float32Array | null;
}

export interface InputFrame {
  source: "camera" | "mouse";
  /** La mano que manda el puntero. */
  primary: HandFrame | null;
  left: HandFrame | null;
  right: HandFrame | null;
  /** Cuadros por segundo de la deteccion, no del render. */
  detectFps: number;
  /**
   * Cuándo se **capturó** la detección de la que sale este cuadro, en el reloj
   * de `performance.now()`. Cero con mouse, donde no hay nada que capturar.
   *
   * Sirve para saber si hay datos nuevos. El render va a 60 y el detector
   * entre 5 y 24, así que la mayoría de los cuadros de render repiten la misma
   * medición: quien dibuje algo derivado de ella -la vista de depuración- no
   * tiene por qué rehacerlo sesenta veces por segundo.
   */
  sampledAt: number;
}

/**
 * Lo que la capa de entrada emite. Dos verbos y nada más.
 *
 * Solo queda `release`: "la mano se abrió". Tomar ya no pasa por aquí, porque
 * cada control se toma a su manera -el botón al cerrar la mano, el deslizador
 * enganchándose, la pieza con el contador- y las tres leen el gesto del cuadro
 * directamente. Soltar sí es común a todo, y por eso viaja como acción.
 */
export type InputAction = "release" | "raiseHand" | "lowerHand";

export interface InputSource {
  readonly kind: "camera" | "mouse";
  start(): Promise<void>;
  stop(): void;
  /** Se lee en cada cuadro de render; no dispara renders de React. */
  read(): InputFrame;
}

export function emptyFrame(source: "camera" | "mouse"): InputFrame {
  return { source, primary: null, left: null, right: null, detectFps: 0, sampledAt: 0 };
}
