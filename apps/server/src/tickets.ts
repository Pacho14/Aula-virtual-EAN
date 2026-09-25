/**
 * PIN -> sala, credencial del profesor y ticket de un solo uso.
 *
 * En la fase 1 esto vive en memoria. En la fase 2 el mapa de PIN pasa a Redis
 * con expiracion y el profesor se autentica contra Supabase, tal como describe
 * la seccion 04 del documento; la interfaz de este modulo no cambia.
 */
import { randomInt, randomUUID } from "node:crypto";
import type { Scene } from "./scene";

export interface Session {
  pin: string;
  roomId: string;
  /**
   * La escena con la que nacio el salon.
   *
   * Vive aqui y no en una constante porque desde la fase 2 cada salon tiene la
   * suya: el nombre, el cupo y los puestos salen de lo que el profesor escribio
   * al crearlo. La API la devuelve tal cual a quien entra con el PIN.
   */
  scene: Scene;
  /**
   * Credencial del profesor que creo el salon. Es lo unico que otorga el rol
   * de profesor: el cliente no puede pedirlo. Sin esto, cualquiera que
   * conozca el PIN entraria con los controles de la clase.
   */
  hostToken: string;
  createdAt: number;
  expiresAt: number;
}

export interface Ticket {
  roomId: string;
  alias: string;
  role: "teacher" | "student";
  /**
   * Identidad del participante en LiveKit. Viaja tambien en el estado de la
   * sala, para que cada cliente sepa que voz corresponde a que avatar y pueda
   * ubicarla en el espacio.
   */
  voiceId: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();
const tickets = new Map<string, Ticket>();

/** Vigencia del PIN en modo sincrono: las horas de la sesion. */
const PIN_TTL_MS = 4 * 60 * 60 * 1000;
/** El ticket solo tiene que sobrevivir el salto de la API a Colyseus. */
const TICKET_TTL_MS = 60 * 1000;

/**
 * Aparta un PIN libre antes de que exista la sala.
 *
 * El salon necesita su PIN en el estado -la vista previa del profesor lo
 * muestra dentro de la escena-, y el estado se llena al crearla. Asi que el
 * PIN se aparta primero y la sala nace sabiendolo. La reserva se mantiene
 * hasta que `createSession` la convierte en sesion, o caduca sola: entre las
 * dos cosas hay un await, y dos profesores creando salones a la vez no pueden
 * salir con el mismo numero.
 */
const reserved = new Map<string, number>();
const RESERVE_TTL_MS = 30 * 1000;

export function reservePin(): string {
  sweep();
  // Hasta 20 intentos para no colisionar con un PIN vivo.
  for (let i = 0; i < 20; i++) {
    const candidate = String(randomInt(100000, 1000000));
    if (!sessions.has(candidate) && !reserved.has(candidate)) {
      reserved.set(candidate, Date.now() + RESERVE_TTL_MS);
      return candidate;
    }
  }
  throw new Error("No se pudo generar un PIN libre.");
}

export function createSession(pin: string, roomId: string, scene: Scene): Session {
  sweep();
  reserved.delete(pin);

  const now = Date.now();
  const session: Session = {
    pin,
    roomId,
    scene,
    hostToken: randomUUID(),
    createdAt: now,
    expiresAt: now + PIN_TTL_MS,
  };
  sessions.set(pin, session);
  return session;
}

export function findSession(pin: string): Session | undefined {
  const session = sessions.get(pin);
  if (!session) return undefined;
  if (session.expiresAt < Date.now()) {
    sessions.delete(pin);
    return undefined;
  }
  return session;
}

/** Se llama cuando una sala se desecha: su PIN deja de tener sentido. */
export function removeSessionByRoomId(roomId: string) {
  for (const [pin, session] of sessions) {
    if (session.roomId === roomId) sessions.delete(pin);
  }
}

export function listSessions(): Session[] {
  sweep();
  return [...sessions.values()];
}

export function issueTicket(roomId: string, alias: string, role: "teacher" | "student") {
  const id = randomUUID();
  const voiceId = randomUUID();
  tickets.set(id, { roomId, alias, role, voiceId, expiresAt: Date.now() + TICKET_TTL_MS });
  return { id, voiceId };
}

/** Un ticket sirve una sola vez: se consume al entrar a la sala. */
export function consumeTicket(id?: string): Ticket | undefined {
  if (!id) return undefined;
  const ticket = tickets.get(id);
  if (!ticket) return undefined;
  tickets.delete(id);
  if (ticket.expiresAt < Date.now()) return undefined;
  return ticket;
}

function sweep() {
  const now = Date.now();
  for (const [pin, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(pin);
  }
  for (const [pin, until] of reserved) {
    if (until < now) reserved.delete(pin);
  }
  for (const [id, ticket] of tickets) {
    if (ticket.expiresAt < now) tickets.delete(id);
  }
}
