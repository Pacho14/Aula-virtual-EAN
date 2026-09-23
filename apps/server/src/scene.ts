/**
 * Escena de la fase 1 - habitacion blanca con tres assets.
 *
 * Es el mismo JSON declarativo que describe el documento de arquitectura
 * (seccion 09). Aqui vive como modulo TypeScript para no depender todavia
 * de Supabase: la fase 1 no persiste nada.
 *
 * `src` admite dos formas:
 *   "prim:box" | "prim:cylinder" | "prim:sphere"  -> primitiva, carga instantanea
 *   "lib/mesa.glb"                                -> GLB servido desde /assets
 *
 * Los tres assets de abajo son primitivas a proposito: la fase 1 valida
 * gestos y sincronizacion, no arte. Cambiar `src` por un GLB no requiere
 * tocar codigo.
 */

export interface SceneAsset {
  id: string;
  src: string;
  label: string;
  pos: [number, number, number];
  rot: [number, number, number];
  scale: number;
  size: [number, number, number];
  color: string;
  interactive: boolean;
  locked: boolean;
}

export interface SceneSpot {
  id: string;
  pos: [number, number, number];
  capacity: number;
}

export interface Scene {
  version: number;
  environment: string;
  mode: "sync" | "async";
  capacity: number;
  /** Mitad del ancho de la sala, en metros. Acota el movimiento de objetos. */
  bounds: { halfSize: number; height: number };
  /**
   * Punto al que mira todo el mundo al entrar: la mesa de trabajo.
   *
   * Sin esto cada quien arranca mirando al centro geometrico de la sala, que
   * esta un metro por encima de donde pasa algo, y los objetos quedan fuera
   * de cuadro.
   */
  focus: [number, number, number];
  assets: SceneAsset[];
  spots: SceneSpot[];
}

/** Angulos para que una camara en `from` mire hacia `to`. */
export function aimAt(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  eyeHeight = 1.6,
) {
  const dx = to[0] - from[0];
  const dy = to[1] - (from[1] + eyeHeight);
  const dz = to[2] - from[2];
  // En three.js una rotacion Y de 0 mira hacia -Z.
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return { yaw, pitch };
}

export const FASE1_SCENE: Scene = {
  version: 4,
  environment: "white-room",
  mode: "sync",
  capacity: 6,
  bounds: { halfSize: 4, height: 3 },
  // La mesa va al centro y todo el mundo se separa de ella: con la mesa
  // encima, la camara se inclina tanto para verla que los demas quedan
  // fuera de cuadro. A esta distancia caben el material y el grupo.
  focus: [0, 1.1, 0],
  assets: [
    {
      id: "mesa",
      src: "prim:box",
      label: "Mesa",
      pos: [0, 0.38, 0],
      rot: [0, 0, 0],
      scale: 1,
      size: [1.4, 0.76, 0.8],
      color: "#C9D2D1",
      interactive: false,
      locked: true,
    },
    {
      id: "valvula",
      src: "prim:cylinder",
      label: "Valvula",
      pos: [-0.35, 0.92, 0],
      rot: [0, 0, 0],
      scale: 1,
      size: [0.14, 0.22, 0.14],
      color: "#0B6E67",
      interactive: true,
      locked: false,
    },
    {
      id: "pieza",
      src: "prim:box",
      label: "Pieza de repuesto",
      pos: [0.35, 0.86, 0],
      rot: [0, 0, 0],
      scale: 1,
      size: [0.18, 0.18, 0.18],
      color: "#B4531A",
      interactive: true,
      locked: false,
    },
  ],
  // Los estudiantes en arco frente a la mesa; el profesor al otro lado,
  // mirandolos. Asi cada quien tiene el material al frente y al grupo
  // detras de el, como en un taller.
  spots: [
    { id: "s1", pos: [-1.7, 0, 2.0], capacity: 1 },
    { id: "s2", pos: [-0.85, 0, 2.35], capacity: 1 },
    { id: "s3", pos: [0, 0, 2.5], capacity: 1 },
    { id: "s4", pos: [0.85, 0, 2.35], capacity: 1 },
    { id: "s5", pos: [1.7, 0, 2.0], capacity: 1 },
    { id: "prof", pos: [0, 0, -2.2], capacity: 1 },
  ],
};

/** Paleta de colores de participante (seccion 06 del documento). */
export const PLAYER_COLORS = [
  "#0B6E67",
  "#B4531A",
  "#2E5FA3",
  "#8A3A7B",
  "#5C7A1E",
  "#A32A20",
  "#0F8C9E",
  "#6B4FB8",
  "#9A6A00",
  "#356B4A",
  "#C1436B",
  "#4A5A6B",
];
