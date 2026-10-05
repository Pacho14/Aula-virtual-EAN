/**
 * Mute forzado de verdad, desde el servidor de medios.
 *
 * `voiceToken()` en index.ts da `canPublish: true` a todos al entrar: eso no
 * cambia aqui. Lo que hace esto es revocar ese permiso ya con la sala en
 * marcha, directamente en LiveKit, para que silenciar a un estudiante no
 * dependa de que su cliente colabore. Si el cliente intenta reabrir el
 * microfono -lo que crearia un track nuevo-, LiveKit lo rechaza porque el
 * permiso de publicar ya no esta.
 *
 * Usa las mismas credenciales que ya firman los tokens: no hace falta
 * webhooks ni ninguna pieza nueva de infraestructura, solo una llamada REST
 * puntual cuando el profesor pulsa silenciar.
 */
import { RoomServiceClient } from "livekit-server-sdk";

const LIVEKIT_URL = process.env.LIVEKIT_URL ?? "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? "";

export const voiceAdminEnabled = Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);

const client = voiceAdminEnabled
  ? new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
  : null;

/**
 * Permite o revoca que esta identidad publique audio en la sala de LiveKit.
 *
 * Silencioso ante cualquier error: si el participante ya se desconecto de
 * LiveKit, o la sala todavia no existe ahi, no hay nada que forzar y no es
 * un motivo para tumbar el mensaje de Colyseus que lo pidio.
 */
export async function setCanPublish(room: string, identity: string, canPublish: boolean) {
  if (!client || !identity) return;
  try {
    await client.updateParticipant(room, identity, {
      permission: { canPublish, canSubscribe: true },
    });
  } catch {
    // El estudiante pudo haberse ido justo antes de que esto llegara.
  }
}
