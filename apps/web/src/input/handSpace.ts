/**
 * De las coordenadas de MediaPipe al espacio de la vista, en primera persona.
 *
 * Aquí no hay three, ni DOM, ni MediaPipe: son números entrando y números
 * saliendo. Está así a propósito, porque es la parte que se equivocó antes y
 * la única manera de no volver a equivocarse es poder probarla sin abrir un
 * navegador (ver `scripts/manos.mjs`).
 *
 * ## Los dos sistemas
 *
 * MediaPipe entrega sus puntos con **X a la derecha de la imagen, Y hacia
 * abajo y Z alejándose de la cámara** -su documentación lo dice al revés,
 * "cuanto menor el valor, más cerca de la cámara", que es lo mismo. Ese
 * sistema es de mano derecha: derecha × abajo = lejos.
 *
 * three también es de mano derecha, pero con **Y hacia arriba y Z hacia el
 * espectador**.
 *
 * ## La conversión, que son dos giros y ninguna reflexión
 *
 * 1. Cambio de convención de ejes, MediaPipe → three: giro de 180° sobre X.
 *    Niega Y y niega Z.
 * 2. Cambio de punto de vista, cámara → ojos: la webcam está enfrente
 *    mirándote y tú la miras a ella, así que las dos vistas se diferencian en
 *    un giro de 180° sobre la vertical. Niega X y niega Z.
 *
 * Compuesto: **X se niega, Y se niega, Z se queda**. Y eso es lo importante:
 * el determinante tiene que dar +1. Negar los tres ejes -que es lo que hacía
 * este código antes- da −1, y un determinante −1 no es un giro sino un
 * espejo: la mano derecha sale con la forma de una izquierda y los dedos
 * estirados hacia la webcam salen apuntando a la propia cara.
 *
 * ## Qué significa la profundidad
 *
 * Con el giro bien puesto, la profundidad sale sola y coincide con lo que hace
 * el cuerpo: empujar la mano hacia la webcam es alejarla de los propios ojos,
 * así que la mano se adentra en la escena, hacia lo que hay sobre la mesa.
 * Recogerla contra el pecho la trae hacia la cara. No hay nada que invertir
 * para que se sienta bien; solo hay que no romper el giro.
 */

/** Índices de MediaPipe que hacen falta aquí. Misma numeración que `LANDMARKS`. */
const WRIST = 0;
const INDEX_MCP = 5;
const PINKY_MCP = 17;

export const JOINT_COUNT = 21;

/**
 * El giro de arriba, un signo por eje.
 *
 * Están sueltos para que la prueba pueda multiplicarlos y comprobar que el
 * determinante sigue siendo +1 sin tener que leer el código.
 */
export const VIEW_SIGN_X = -1;
export const VIEW_SIGN_Y = -1;
export const VIEW_SIGN_Z = 1;

/** Determinante de la conversión. Tiene que ser +1: un giro, no un espejo. */
export const VIEW_DETERMINANT = VIEW_SIGN_X * VIEW_SIGN_Y * VIEW_SIGN_Z;

export type Vec3 = [number, number, number];

/**
 * Lleva los 21 puntos de `worldLandmarks` al espacio de la vista, relativos a
 * la muñeca y en metros.
 *
 * `worldLandmarks` ya viene en metros con la proporción de la mano resuelta
 * por el modelo, así que aquí no se escala nada: el tamaño aparente lo decide
 * la perspectiva, es decir a qué distancia se coloque el grupo (`viewDepth`).
 */
export function toViewSpace(world: Float32Array, out: Float32Array): void {
  const ox = world[WRIST * 3]!;
  const oy = world[WRIST * 3 + 1]!;
  const oz = world[WRIST * 3 + 2]!;
  for (let i = 0; i < JOINT_COUNT; i++) {
    out[i * 3] = VIEW_SIGN_X * (world[i * 3]! - ox);
    out[i * 3 + 1] = VIEW_SIGN_Y * (world[i * 3 + 1]! - oy);
    out[i * 3 + 2] = VIEW_SIGN_Z * (world[i * 3 + 2]! - oz);
  }
}

/** Punta del índice, en la numeración de MediaPipe. */
export const INDEX_TIP = 8;

/**
 * Un solo punto, relativo a la muñeca y en los ejes de la vista.
 *
 * Es `toViewSpace` para un punto suelto, sin recorrer los 21. Hace falta para
 * anclar la mano dibujada: el grupo se coloca por la muñeca, pero lo que
 * tiene que caer sobre el rayo del puntero es la punta del índice, así que
 * hay que saber cuánto separa una de otra.
 */
export function jointInViewSpace(world: Float32Array, joint: number, out: Vec3): Vec3 {
  out[0] = VIEW_SIGN_X * (world[joint * 3]! - world[WRIST * 3]!);
  out[1] = VIEW_SIGN_Y * (world[joint * 3 + 1]! - world[WRIST * 3 + 1]!);
  out[2] = VIEW_SIGN_Z * (world[joint * 3 + 2]! - world[WRIST * 3 + 2]!);
  return out;
}

/** El mismo giro, para un vector suelto. Lo usa la prueba de quiralidad. */
export function vectorToViewSpace(v: Vec3): Vec3 {
  return [VIEW_SIGN_X * v[0], VIEW_SIGN_Y * v[1], VIEW_SIGN_Z * v[2]];
}

/**
 * Normal del plato de los nudillos: (índice − muñeca) × (meñique − muñeca).
 *
 * En cualquier sistema de mano derecha, y para una **mano derecha**, este
 * producto apunta hacia donde mira la palma. Para una izquierda apunta al
 * dorso. Es la única cantidad de la mano que distingue una mano de su reflejo,
 * así que es con la que se comprueba que la conversión no es un espejo.
 */
export function knuckleNormal(points: Float32Array): Vec3 {
  const ax = points[INDEX_MCP * 3]! - points[WRIST * 3]!;
  const ay = points[INDEX_MCP * 3 + 1]! - points[WRIST * 3 + 1]!;
  const az = points[INDEX_MCP * 3 + 2]! - points[WRIST * 3 + 2]!;
  const bx = points[PINKY_MCP * 3]! - points[WRIST * 3]!;
  const by = points[PINKY_MCP * 3 + 1]! - points[WRIST * 3 + 1]!;
  const bz = points[PINKY_MCP * 3 + 2]! - points[WRIST * 3 + 2]!;
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

/**
 * Distancia focal de la webcam, en unidades de "alto de imagen normalizado".
 *
 * Es `F / alto_en_pixeles`, o lo mismo: `1 / (2 · tan(fov_vertical / 2))`. El
 * 1,16 corresponde a unos 47° verticales, que es una webcam de portátil
 * típica. Es la **única** constante de aquí que depende del equipo: si las
 * distancias salen todas escaladas por el mismo factor, este es el número que
 * hay que mover, y `REACH.rest` absorbe casi todo el error.
 */
const FOCAL = 1.16;

/**
 * Distancia de la mano a la webcam, en metros. Devuelve 0 si no hay señal.
 *
 * El truco está en comparar la separación **aparente** de los puntos -en la
 * imagen- contra su separación **real medida en el plano de la imagen**: las
 * componentes X e Y de `worldLandmarks`, que son paralelas a ese plano. Esas
 * dos se encogen igual cuando la mano gira, así que el cociente no cambia al
 * girarla. Ese es justo el defecto de medir la profundidad con una sola
 * distancia 2D, que se encoge al girar la mano y la hace "irse" sin que se
 * haya movido.
 *
 * Se ajusta sobre los 21 puntos por mínimos cuadrados en vez de sobre un par
 * elegido a mano, y todo relativo al centroide de cada conjunto, de modo que
 * da igual dónde ponga MediaPipe el origen de `worldLandmarks`.
 *
 * @param image  Los 21 puntos normalizados a la imagen, 3 números por punto.
 * @param world  Los mismos en metros.
 * @param aspect Ancho/alto del cuadro que vio el detector. Hace falta porque
 *               X e Y vienen normalizados a lados distintos: sin esto la
 *               distancia cambiaría al pasar la mano de vertical a horizontal.
 */
export function estimateCameraDistance(
  image: Float32Array,
  world: Float32Array,
  aspect: number,
): number {
  let cix = 0;
  let ciy = 0;
  let cwx = 0;
  let cwy = 0;
  for (let i = 0; i < JOINT_COUNT; i++) {
    cix += image[i * 3]!;
    ciy += image[i * 3 + 1]!;
    cwx += world[i * 3]!;
    cwy += world[i * 3 + 1]!;
  }
  cix /= JOINT_COUNT;
  ciy /= JOINT_COUNT;
  cwx /= JOINT_COUNT;
  cwy /= JOINT_COUNT;

  // Ajuste de la escala s en (du·aspecto, dv) = s · (dX, dY).
  let num = 0;
  let den = 0;
  for (let i = 0; i < JOINT_COUNT; i++) {
    const du = (image[i * 3]! - cix) * aspect;
    const dv = image[i * 3 + 1]! - ciy;
    const dx = world[i * 3]! - cwx;
    const dy = world[i * 3 + 1]! - cwy;
    num += du * dx + dv * dy;
    den += dx * dx + dy * dy;
  }
  if (den < 1e-9 || num <= 1e-9) return 0;

  // s sale en "altos de imagen por metro"; la distancia es la focal entre s.
  return (FOCAL * den) / num;
}

/**
 * Cómo se traduce "acercar o alejar la mano" a profundidad en la escena.
 *
 * Es el análogo en profundidad de `GAIN` en cameraSource.ts: la zona cómoda
 * del brazo tiene que cubrir un rango útil de la escena sin pedirle a nadie
 * que estire el codo hasta el final.
 */
export const REACH = {
  /** Distancia webcam-mano con el codo relajado y el antebrazo levantado. */
  rest: 0.45,
  /** A qué profundidad flota la mano en ese reposo, desde el ojo. */
  restDepth: 0.5,
  /** Cuánto se adentra la mano por cada metro que se acerca a la webcam. */
  gain: 1.6,
  /** Topes: más cerca tapa la escena entera, más lejos ya no se distingue. */
  near: 0.28,
  far: 1.1,
} as const;

/**
 * Profundidad a la que se dibuja la mano, en metros desde el ojo.
 *
 * Acercar la mano a la webcam es alejarla de los propios ojos, así que la mano
 * se adentra en la escena: de ahí el signo. Estirar el brazo hacia la pantalla
 * lleva la mano hacia lo que hay sobre la mesa, y recogerla contra el pecho la
 * trae hacia la cara, donde se ve grande solo por perspectiva.
 */
export function viewDepth(cameraDistance: number): number {
  if (!(cameraDistance > 0)) return REACH.restDepth;
  const depth = REACH.restDepth + (REACH.rest - cameraDistance) * REACH.gain;
  return depth < REACH.near ? REACH.near : depth > REACH.far ? REACH.far : depth;
}
