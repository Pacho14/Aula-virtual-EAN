/**
 * La escena del salon.
 *
 * Hasta la fase 1 esto era una constante con tres assets fijos. Ahora el salon
 * nace practicamente vacio -suelo y mesa- y lo arma el profesor con las manos
 * antes de empezar la clase, asi que la escena se construye por salon: el
 * nombre, el numero de estudiantes y los puestos salen de lo que el profesor
 * escribio al crearlo.
 *
 * Sigue siendo el mismo JSON declarativo del documento de arquitectura
 * (seccion 09); lo que cambia es que ya no hay uno solo.
 *
 * `src` admite dos formas:
 *   "prim:box" | "prim:cylinder" | "prim:sphere"  -> primitiva, carga instantanea
 *   "lib/mesa.glb"                                -> GLB servido desde /assets
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

/**
 * Donde se puede dejar un objeto, y como se pega al soltarlo.
 *
 * Existe para que nada quede flotando ni se vaya a un rincon donde nadie lo
 * alcanza: el tablero de la mesa y una franja de piso alrededor, y nada mas.
 */
export interface PlacementZone {
  /** Tablero: rectangulo en XZ y altura de la superficie, en metros. */
  table: { center: [number, number]; half: [number, number]; top: number };
  /** Piso utilizable alrededor de la mesa. Contiene al tablero. */
  floor: { center: [number, number]; half: [number, number] };
  /** Paso del iman, en metros. */
  grid: number;
  /**
   * Fraccion del paso dentro de la cual el iman tira.
   *
   * Con 1 el objeto salta de casilla en casilla y el arrastre se ve a
   * tirones; con esto el objeto se desliza suave y solo se encaja cuando ya
   * esta cerca, que es como se siente el iman de Blender.
   */
  pull: number;
  /**
   * Cuanto mas alla del borde del tablero sigue atrayendo la mesa, en metros.
   * Sin esto, apuntar un centimetro afuera manda el objeto al piso.
   */
  reach: number;
}

export interface Scene {
  version: number;
  environment: string;
  mode: "sync" | "async";
  /** Cupo total de la sala: los estudiantes mas el profesor. */
  capacity: number;
  /** En cual de los tres salones del lobby se abrio la clase. */
  salon: number;
  /** Lo que escribio el profesor al crear el salon: el nombre de la clase. */
  roomName: string;
  students: number;
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
  placement: PlacementZone;
  assets: SceneAsset[];
  spots: SceneSpot[];
}

/** Version del formato de escena. Sube cuando cambia la forma, no el contenido. */
export const SCENE_VERSION = 5;

/** Lo maximo que se puede escribir en "numero de estudiantes". */
export const MAX_STUDENTS = 12;

/** Las tres primitivas que el profesor puede sacar del panel de objetos. */
export const PRIMITIVES = {
  sphere: { label: "Esfera", size: [0.18, 0.18, 0.18], color: "#0B6E67" },
  cylinder: { label: "Cilindro", size: [0.16, 0.24, 0.16], color: "#B4531A" },
  box: { label: "Cubo", size: [0.18, 0.18, 0.18], color: "#2E5FA3" },
} as const;

export type PrimitiveName = keyof typeof PRIMITIVES;

export function isPrimitiveName(value: unknown): value is PrimitiveName {
  return typeof value === "string" && value in PRIMITIVES;
}

/** La mesa: lo unico que trae el salon de fabrica. */
const TABLE: SceneAsset = {
  id: "mesa",
  src: "prim:box",
  label: "Mesa",
  pos: [0, 0.38, 0],
  rot: [0, 0, 0],
  scale: 1,
  size: [1.4, 0.76, 0.8],
  // Gris medio y no claro: la mesa es el fondo sobre el que se ven las
  // piezas, y con un entorno 360 luminoso una mesa clara se va a blanco y
  // se traga lo que tiene encima.
  color: "#8E9B9A",
  interactive: false,
  locked: true,
};

const PLACEMENT: PlacementZone = {
  table: { center: [0, 0], half: [0.7, 0.4], top: TABLE.size[1] },
  // Poco mas de medio metro de piso por lado. Mas que eso y el objeto queda
  // detras de alguien; menos, y no hay donde apartar lo que no se esta usando.
  floor: { center: [0, 0], half: [1.45, 1.1] },
  grid: 0.05,
  pull: 0.35,
  reach: 0.12,
};

/**
 * Construye la escena de un salon.
 *
 * Los puestos se reparten en arco frente a la mesa segun cuantos estudiantes
 * dijo el profesor, y el profesor queda al otro lado mirandolos: cada quien
 * tiene el material al frente y al grupo enfrente, como en un taller.
 */
export function makeScene(
  options: { roomName?: string; students?: number; salon?: number } = {},
): Scene {
  const students = clampStudents(options.students);
  const spots = makeSpots(students);

  return {
    version: SCENE_VERSION,
    environment: "white-room",
    mode: "sync",
    capacity: students + 1,
    salon: options.salon ?? 1,
    roomName: (options.roomName ?? "").trim().slice(0, 48) || "Clase sin nombre",
    students,
    // El doble de lo que medía antes (era 4). El suelo es lo que le da al ojo
    // la escala que la mano no alcanza a dar -ver la rejilla en WhiteRoom-, y
    // con un entorno 360 detrás, un suelo corto hace que el paisaje arranque
    // casi a los pies y el salón se sienta como una tarima.
    //
    // Esto solo agranda el **espacio**: la zona del imán (`PLACEMENT`) y la
    // mesa se quedan igual a propósito, así que ninguna pieza cambia de sitio
    // y el imán sigue encajando donde encajaba. Repartir los puestos más
    // lejos sería otra cosa, y habría que moverlo en `makeSpots`.
    bounds: { halfSize: 8, height: 3 },
    focus: [0, 1.1, 0],
    placement: PLACEMENT,
    assets: [{ ...TABLE }],
    spots,
  };
}

export function clampStudents(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 5;
  return Math.min(MAX_STUDENTS, Math.max(1, n));
}

function makeSpots(students: number): SceneSpot[] {
  // El arco se abre hasta 150 grados y se aleja a medida que entra mas gente,
  // para que nadie termine encima de la mesa ni de espaldas a ella.
  const step = Math.min(0.42, students > 1 ? 2.6 / (students - 1) : 0.42);
  const radius = 2.2 + students * 0.075;
  const spots: SceneSpot[] = [];

  for (let i = 0; i < students; i++) {
    const angle = (i - (students - 1) / 2) * step;
    spots.push({
      id: `s${i + 1}`,
      pos: [round(Math.sin(angle) * radius), 0, round(Math.cos(angle) * radius)],
      capacity: 1,
    });
  }

  spots.push({ id: "prof", pos: [0, 0, -2.2], capacity: 1 });
  return spots;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
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

// ---------------------------------------------------------------------------
// El iman
// ---------------------------------------------------------------------------

export interface Placed {
  x: number;
  y: number;
  z: number;
  onTable: boolean;
}

/**
 * Pega una posicion arbitraria a la zona permitida.
 *
 * Con seguimiento por camara la profundidad es lo mas impreciso que hay: el
 * objeto se va al aire, o queda medio metro detras de la mesa, y el profesor
 * pelea con el en vez de armar la escena. Esto resuelve las tres cosas de una
 * vez: recorta a la zona, encaja en una rejilla de 5 cm y apoya el objeto en
 * la superficie que le toca, mesa o piso.
 *
 * Corre igual en el servidor -que es la autoridad- y en el cliente -que
 * predice mientras se arrastra-. Esta duplicada en apps/web/src/scene/
 * placement.ts: si cambias una, cambia la otra o el objeto saltara al soltarlo.
 */
export function snapToPlacement(
  zone: PlacementZone,
  x: number,
  z: number,
  half: readonly [number, number, number],
): Placed {
  const floorX = clamp(x, zone.floor.center[0] - zone.floor.half[0], zone.floor.center[0] + zone.floor.half[0]);
  const floorZ = clamp(z, zone.floor.center[1] - zone.floor.half[1], zone.floor.center[1] + zone.floor.half[1]);

  // El tablero atrae desde un poco mas afuera de su borde: apuntar al filo
  // deberia dejar el objeto sobre la mesa, no tirarlo al piso.
  const overTable =
    Math.abs(floorX - zone.table.center[0]) <= zone.table.half[0] + zone.reach &&
    Math.abs(floorZ - zone.table.center[1]) <= zone.table.half[1] + zone.reach;

  if (overTable) {
    // El objeto entero tiene que caber en el tablero: si el centro se acerca
    // demasiado al borde, media pieza quedaria en el aire.
    const marginX = Math.max(0, zone.table.half[0] - half[0]);
    const marginZ = Math.max(0, zone.table.half[1] - half[2]);
    return {
      x: magnet(clamp(floorX, zone.table.center[0] - marginX, zone.table.center[0] + marginX), zone),
      y: zone.table.top + half[1],
      z: magnet(clamp(floorZ, zone.table.center[1] - marginZ, zone.table.center[1] + marginZ), zone),
      onTable: true,
    };
  }

  return {
    x: magnet(floorX, zone),
    y: half[1],
    z: magnet(floorZ, zone),
    onTable: false,
  };
}

/** Encaja en la rejilla solo cuando ya esta cerca. Ver `pull`. */
function magnet(value: number, zone: PlacementZone) {
  const nearest = Math.round(value / zone.grid) * zone.grid;
  return Math.abs(value - nearest) < zone.grid * zone.pull ? nearest : value;
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}

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
