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

export interface Scene {
  version: number;
  environment: string;
  mode: "sync" | "async";
  capacity: number;
  bounds: { halfSize: number; height: number };
  /** Punto al que mira todo el mundo al entrar: la mesa de trabajo. */
  focus: [number, number, number];
  assets: SceneAsset[];
  spots: SceneSpot[];
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

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error ?? `El servidor respondio ${response.status}.`);
  }
  return payload as T;
}

export interface CreatedSession {
  pin: string;
  roomId: string;
  /** Credencial de profesor de ese salón. Guárdala: no se puede recuperar. */
  hostToken: string;
  expiresAt: number;
}

/** Solo el profesor: exige el código que imprime el servidor al arrancar. */
export function createSession(code: string) {
  return post<CreatedSession>("/api/sessions", { code });
}

/**
 * El rol lo decide el servidor. Con hostToken entras como profesor; sin él,
 * como estudiante. No hay forma de pedirlo desde aquí.
 */
export function joinSession(pin: string, alias: string, hostToken?: string) {
  return post<JoinResult>("/api/join", { pin, alias, hostToken });
}
