/**
 * Conexion a la sala de Colyseus.
 *
 * El estado se lee directamente del objeto que mantiene el SDK: los avatares y
 * los objetos se actualizan dentro de useFrame, no con estado de React. A 20 Hz
 * por participante, re-renderizar React seria el primer cuello de botella.
 * React solo se entera de las altas y bajas.
 */
import { Client, getStateCallbacks, type Room } from "@colyseus/sdk";
import { API_BASE } from "./api";

export interface HandView {
  tracked: boolean;
  gesture: number;
  x: number;
  y: number;
  z: number;
}

export interface PlayerView {
  alias: string;
  role: "teacher" | "student";
  color: string;
  spotId: string;
  voiceId: string;
  handRaised: boolean;
  speaking: boolean;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
  pitch: number;
  left: HandView;
  right: HandView;
}

export interface ObjectView {
  src: string;
  label: string;
  color: string;
  sx: number;
  sy: number;
  sz: number;
  x: number;
  y: number;
  z: number;
  ry: number;
  interactive: boolean;
  locked: boolean;
  heldBy: string;
}

export interface AulaStateView {
  pin: string;
  environment: string;
  halfSize: number;
  players: Map<string, PlayerView>;
  objects: Map<string, ObjectView>;
}

export type AulaRoom = Room<any, AulaStateView>;

export interface RoomHandle {
  room: AulaRoom;
  sessionId: string;
  dispose(): void;
}

/**
 * Espera a que la sala tenga estado utilizable.
 *
 * No basta con que llegue "un" estado: joinById resuelve al abrirse el
 * WebSocket, y el primer aviso de cambio puede traer la raiz sin sus
 * colecciones todavia. La escena lee players y objects en el primer render,
 * asi que se espera hasta que ambos existan.
 */
function firstState(room: AulaRoom, timeoutMs = 10000): Promise<void> {
  const ready = () => Boolean(room.state?.players && room.state?.objects);
  if (ready()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const check = () => {
      if (!ready()) return;
      clearTimeout(timer);
      room.onStateChange.remove(check);
      resolve();
    };

    const timer = setTimeout(() => {
      room.onStateChange.remove(check);
      console.error("[aula] estado incompleto:", room.state && Object.keys(room.state));
      void room.leave();
      reject(new Error("La sala no envió su estado a tiempo. Intenta de nuevo."));
    }, timeoutMs);

    room.onStateChange(check);
  });
}

export interface RoomEvents {
  onPlayers(ids: string[]): void;
  onObjects(ids: string[]): void;
  onLeave(code: number): void;
  onError(message: string): void;
}

export async function connectToRoom(
  roomId: string,
  ticket: string,
  events: RoomEvents,
): Promise<RoomHandle> {
  const client = new Client(API_BASE);
  const room = (await client.joinById(roomId, { ticket })) as AulaRoom;

  // joinById resuelve cuando el WebSocket queda abierto, no cuando llega el
  // primer estado. Devolver la sala antes de eso deja a la escena leyendo
  // room.state indefinido y tumba el render entero.
  await firstState(room);

  const $ = getStateCallbacks(room);
  const playerIds = new Set<string>();
  const objectIds = new Set<string>();

  $(room.state).players.onAdd((_player: PlayerView, id: string) => {
    playerIds.add(id);
    events.onPlayers([...playerIds]);
  });
  $(room.state).players.onRemove((_player: PlayerView, id: string) => {
    playerIds.delete(id);
    events.onPlayers([...playerIds]);
  });
  $(room.state).objects.onAdd((_object: ObjectView, id: string) => {
    objectIds.add(id);
    events.onObjects([...objectIds]);
  });
  $(room.state).objects.onRemove((_object: ObjectView, id: string) => {
    objectIds.delete(id);
    events.onObjects([...objectIds]);
  });

  room.onLeave((code: number) => events.onLeave(code));
  room.onError((code: number, message?: string) =>
    events.onError(message ?? `Error ${code} en la sala.`),
  );

  return {
    room,
    sessionId: room.sessionId,
    dispose() {
      void room.leave();
    },
  };
}
