/**
 * La cámara: fija en su sitio, y solo mira alrededor.
 *
 * No hay desplazamiento. Ni caminar, ni acercarse, ni moverse en X o en Z: la
 * cámara vive en el puesto asignado y lo único que cambia es hacia dónde mira.
 * Esa restricción es deliberada y vale por dos: con seguimiento de manos por
 * cámara no hay forma cómoda de caminar, y en una clase todo el mundo tiene
 * que seguir estando donde los demás creen que está.
 *
 * Quien mueve la mirada es el deslizador, no la mano. La mano agarra el
 * deslizador con un pellizco y el deslizador gira la cámara:
 *
 *   MediaPipe → puntos de la mano → pellizco → deslizador → giro de la cámara
 *
 * Esto vive fuera de React porque lo leen el bucle de render, los controles en
 * pantalla y el arrastre con mouse, y porque cambia a 24 Hz mientras alguien
 * arrastra. `useSyncExternalStore` lo conecta con los componentes que sí
 * necesitan repintarse.
 */

/** Recorrido de los dos deslizadores, en radianes desde la orientación base. */
export const LIMITES = {
  /** 180 grados en total: de -90 a +90. */
  yaw: Math.PI / 2,
  /**
   * El vertical va más corto a propósito. Mirando muy arriba se pierde de
   * vista la mesa, que es donde pasa todo, y mirando muy abajo se ve el suelo
   * y poco más.
   */
  pitch: 0.7,
};

interface Rig {
  /** Orientación de partida: la que mira a la mesa de trabajo. */
  restYaw: number;
  restPitch: number;
  /** Desvío respecto de la de partida. Es lo que muestran los deslizadores. */
  yaw: number;
  pitch: number;
  /**
   * Cierto mientras la mano tiene agarrado un control en pantalla.
   *
   * La escena lo consulta para no hacer dos cosas con el mismo gesto: quien
   * está arrastrando el deslizador de la cámara no está, además, agarrando una
   * pieza de la mesa.
   */
  handBusy: boolean;
}

export const cameraRig: Rig = {
  restYaw: 0,
  restPitch: 0,
  yaw: 0,
  pitch: 0,
  handBusy: false,
};

const listeners = new Set<() => void>();

/** Para `useSyncExternalStore`. */
export function subscribeRig(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Instantánea de los dos ángulos, en grados.
 *
 * Devuelve la misma cadena mientras no cambien: `useSyncExternalStore` compara
 * por identidad, y un objeto nuevo en cada lectura sería un bucle de renders.
 */
let snapshot = "0|0";

export function rigSnapshot() {
  return snapshot;
}

export function rigDegrees() {
  const [yaw, pitch] = snapshot.split("|");
  return { yaw: Number(yaw), pitch: Number(pitch) };
}

function announce() {
  const next = `${Math.round((cameraRig.yaw * 180) / Math.PI)}|${Math.round(
    (cameraRig.pitch * 180) / Math.PI,
  )}`;
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Coloca la orientación de partida y vuelve la mirada al centro. */
export function restRig(restYaw: number, restPitch: number) {
  cameraRig.restYaw = restYaw;
  cameraRig.restPitch = restPitch;
  cameraRig.yaw = 0;
  cameraRig.pitch = 0;
  cameraRig.handBusy = false;
  announce();
}

export function setRigYaw(radians: number) {
  cameraRig.yaw = clamp(radians, -LIMITES.yaw, LIMITES.yaw);
  announce();
}

export function setRigPitch(radians: number) {
  cameraRig.pitch = clamp(radians, -LIMITES.pitch, LIMITES.pitch);
  announce();
}

/** Lo usa el arrastre con mouse, que mueve los dos a la vez. */
export function nudgeRig(deltaYaw: number, deltaPitch: number) {
  cameraRig.yaw = clamp(cameraRig.yaw + deltaYaw, -LIMITES.yaw, LIMITES.yaw);
  cameraRig.pitch = clamp(cameraRig.pitch + deltaPitch, -LIMITES.pitch, LIMITES.pitch);
  announce();
}

export function degrees(radians: number) {
  return Math.round((radians * 180) / Math.PI);
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}
