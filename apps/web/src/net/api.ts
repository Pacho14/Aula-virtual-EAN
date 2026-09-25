/**
 * Cliente de la API.
 *
 * Por defecto habla con el mismo origen desde el que se sirvio la pagina, que
 * es lo correcto detras del tunel: un solo hostname para app, API y Colyseus.
 * En desarrollo local, VITE_API_URL apunta al puerto del servidor.
 */
/** Puerto del servidor cuando el cliente lo sirve Vite en otro puerto. */
const SERVER_PORT = import.meta.env.VITE_SERVER_PORT ?? "2567";

function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_URL?.trim();
  if (configured) return configured;

  // Compilado (y detras del tunel) la pagina sale del mismo servidor que la
  // API, asi que el mismo origen es siempre lo correcto.
  if (!import.meta.env.DEV) return window.location.origin;

  // En desarrollo Vite corre en 5173 y el servidor en 2567. Se conserva el
  // hostname en vez de fijar "localhost" para que tambien funcione al abrirlo
  // desde el celular con la IP de la LAN.
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${SERVER_PORT}`;
}

export const API_BASE: string = resolveApiBase();

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
 * Lo fija el servidor, que es quien aplica el imán de verdad. Aquí llega para
 * que el arrastre prediga lo mismo y la pieza no salte al confirmarse.
 */
export interface PlacementZone {
  table: { center: [number, number]; half: [number, number]; top: number };
  floor: { center: [number, number]; half: [number, number] };
  grid: number;
  pull: number;
  reach: number;
}

export interface Scene {
  version: number;
  environment: string;
  mode: "sync" | "async";
  /** Cupo total: los estudiantes más el profesor. */
  capacity: number;
  roomName: string;
  students: number;
  bounds: { halfSize: number; height: number };
  /** Punto al que mira todo el mundo al entrar: la mesa de trabajo. */
  focus: [number, number, number];
  placement: PlacementZone;
  assets: SceneAsset[];
  spots: SceneSpot[];
}

/** Un entorno 360 del carrusel, tal como lo publica /api/environments. */
export interface Environment {
  id: string;
  label: string;
  file: string;
  thumb: string;
  width: number;
  height: number;
  bytes: number;
}

/** Ángulos para que una cámara en `from` mire hacia `to`. */
export function aimAt(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  eyeHeight = 1.6,
) {
  const dx = to[0] - from[0];
  const dy = to[1] - (from[1] + eyeHeight);
  const dz = to[2] - from[2];
  // En three.js una rotación Y de 0 mira hacia -Z.
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return { yaw, pitch };
}

export interface JoinResult {
  roomId: string;
  ticket: string;
  voiceId: string;
  alias: string;
  role: "teacher" | "student";
  scene: Scene;
  voice: { url: string; token: string } | null;
}

/**
 * Un salón que existe pero todavía no recibe a nadie.
 *
 * No es un error del estudiante ni de la red: el profesor está armando la
 * escena. La pantalla de entrada lo distingue para reintentar sola en vez de
 * mandar a alguien a revisar su PIN, que está bien.
 */
export class RoomNotReady extends Error {
  constructor(
    message: string,
    readonly roomName: string,
  ) {
    super(message);
    this.name = "RoomNotReady";
  }
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 409 && payload?.waiting) {
      throw new RoomNotReady(payload.error, payload.roomName ?? "");
    }
    throw new Error(payload?.error ?? `El servidor respondio ${response.status}.`);
  }
  return payload as T;
}

export interface CreatedSession {
  pin: string;
  roomId: string;
  roomName: string;
  students: number;
  /** Credencial de profesor de ese salón. Guárdala: no se puede recuperar. */
  hostToken: string;
  expiresAt: number;
}

/** Solo el profesor: exige el código que imprime el servidor al arrancar. */
export function createSession(code: string, roomName: string, students: number) {
  return post<CreatedSession>("/api/sessions", { code, roomName, students });
}

/** El catálogo del carrusel. Solo miniaturas; las HDRI bajan al elegirlas. */
export async function fetchEnvironments(): Promise<Environment[]> {
  const response = await fetch(`${API_BASE}/api/environments`);
  if (!response.ok) throw new Error("No se pudo leer el catálogo de entornos.");
  return (await response.json()) as Environment[];
}

/** Absolutiza una ruta del catálogo contra el servidor que sirve la API. */
export function assetUrl(path: string) {
  return `${API_BASE}${path}`;
}

/**
 * El rol lo decide el servidor. Con hostToken entras como profesor; sin él,
 * como estudiante. No hay forma de pedirlo desde aquí.
 */
export function joinSession(pin: string, alias: string, hostToken?: string) {
  return post<JoinResult>("/api/join", { pin, alias, hostToken });
}
