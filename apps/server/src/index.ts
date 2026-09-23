import "dotenv/config";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import compression from "compression";
import cors from "cors";
import express from "express";
import { Server, matchMaker } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { AccessToken } from "livekit-server-sdk";

import { AulaRoom } from "./AulaRoom";
import { FASE1_SCENE } from "./scene";
import { createSession, findSession, issueTicket, listSessions } from "./tickets";

const PORT = Number(process.env.PORT ?? 2567);
const DEV_ORIGIN = process.env.DEV_ORIGIN ?? "http://localhost:5173";

/**
 * Codigo que habilita a crear salones. Solo el profesor lo tiene.
 *
 * Si no esta en el .env se genera uno al arrancar y se imprime en la consola,
 * en vez de dejar la creacion abierta: un servidor que cualquiera puede llenar
 * de salones no sirve ni para probar. En la fase 2 esto lo reemplaza la
 * autenticacion de profesor contra Supabase.
 */
const TEACHER_CODE = process.env.TEACHER_CODE?.trim() || randomBytes(4).toString("hex");
const TEACHER_CODE_IS_GENERATED = !process.env.TEACHER_CODE?.trim();

const LIVEKIT_URL = process.env.LIVEKIT_URL ?? "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? "";
const voiceEnabled = Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);

const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, "../../web/dist");
const serverPublic = resolve(here, "../public");

// El transport trae su propia app de Express con las rutas de matchmaking ya
// montadas, asi que la API, el WebSocket y los estaticos salen del mismo
// puerto. Eso es lo que permite exponer todo con un solo hostname en el tunel.
const transport = new WebSocketTransport();
const app = transport.getExpressApp();
const gameServer = new Server({ transport });

// El WASM de MediaPipe pesa 11 MB sin comprimir, contra un presupuesto de
// descarga inicial de 15 MB en celular (seccion 13). Comprimido baja a ~3 MB.
// Sin esta linea la fase 1 no cabe en su propio presupuesto.
app.use(compression());
app.use(
  cors({
    origin: [
      DEV_ORIGIN,
      /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/,
      // Rangos privados: es como se prueba desde el celular en la misma red,
      // abriendo http://192.168.x.x:5173 en vez de localhost.
      /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/,
      /^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/,
      /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(:\d+)?$/,
      /\.trycloudflare\.com$/,
    ],
  }),
);
app.use(express.json({ limit: "64kb" }));

// --------------------------------------------------------------------------
// Limite de intentos por IP sobre el PIN (seccion 13 del documento).
// --------------------------------------------------------------------------
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 20;
const WINDOW_MS = 5 * 60 * 1000;

function tooManyAttempts(ip: string) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

// --------------------------------------------------------------------------
// API
// --------------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    voice: voiceEnabled ? "livekit" : "desactivada",
    sessions: listSessions().length,
  });
});

/** Solo el profesor publica salones, y para eso necesita el codigo. */
app.post("/api/sessions", async (req, res) => {
  const ip = req.ip ?? "desconocida";
  if (tooManyAttempts(ip)) {
    res.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
    return;
  }

  if (!matchesTeacherCode(String(req.body?.code ?? ""))) {
    res.status(401).json({ error: "Código de profesor incorrecto." });
    return;
  }

  try {
    const room = await matchMaker.createRoom("aula", { scene: FASE1_SCENE });
    const session = createSession(room.roomId);
    res.json({
      pin: session.pin,
      roomId: room.roomId,
      // Esta es la credencial que convierte a quien la tenga en el profesor
      // de ESTE salon. No se deriva del PIN a proposito: el PIN se reparte.
      hostToken: session.hostToken,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    console.error("[api] no se pudo crear la sala:", error);
    res.status(500).json({ error: "No se pudo crear el salón." });
  }
});

/** Comparacion en tiempo constante, para no filtrar el codigo a fuerza bruta. */
function matchesTeacherCode(candidate: string) {
  const a = Buffer.from(candidate);
  const b = Buffer.from(TEACHER_CODE);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Un participante entra con PIN y alias. */
app.post("/api/join", async (req, res) => {
  const ip = req.ip ?? "desconocida";
  if (tooManyAttempts(ip)) {
    res.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
    return;
  }

  const pin = String(req.body?.pin ?? "").trim();
  const alias = String(req.body?.alias ?? "").trim().slice(0, 32);
  const hostToken = String(req.body?.hostToken ?? "");

  if (!/^\d{6}$/.test(pin)) {
    res.status(400).json({ error: "El PIN son seis digitos." });
    return;
  }
  if (alias.length < 2) {
    res.status(400).json({ error: "Escribe tu nombre para entrar." });
    return;
  }

  const session = findSession(pin);
  if (!session) {
    res.status(404).json({ error: "Ese PIN no corresponde a ningún salón activo." });
    return;
  }

  // La sala pudo desecharse aunque el PIN siga vivo. Mejor decirlo aqui que
  // dejar que el cliente falle al conectarse con un "room not found".
  const alive = await matchMaker.query({ roomId: session.roomId });
  if (alive.length === 0) {
    res.status(410).json({ error: "Ese salón ya se cerró. Pide un PIN nuevo." });
    return;
  }

  // El rol NO lo elige el cliente: se deriva de tener la credencial que
  // devolvio la creacion del salon. Sin ella se entra como estudiante.
  const role: "teacher" | "student" =
    hostToken && hostToken === session.hostToken ? "teacher" : "student";

  const { id: ticket, voiceId } = issueTicket(session.roomId, alias, role);

  res.json({
    roomId: session.roomId,
    ticket,
    voiceId,
    alias,
    role,
    scene: FASE1_SCENE,
    voice: voiceEnabled
      ? {
          url: LIVEKIT_URL,
          token: await voiceToken(session.roomId, voiceId, alias),
        }
      : null,
  });
});

async function voiceToken(roomId: string, identity: string, alias: string) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name: alias,
    ttl: "4h",
  });
  at.addGrant({ roomJoin: true, room: roomId, canPublish: true, canSubscribe: true });
  return at.toJwt();
}

// --------------------------------------------------------------------------
// Runtime de MediaPipe. Lo sirve el servidor y no Vite porque la libreria
// carga su WASM con un import() dinamico, y Vite prohibe importar archivos de
// su carpeta public desde codigo fuente. Se sirve siempre, tambien en
// desarrollo, para que la ruta sea la misma en los dos modos.
// --------------------------------------------------------------------------
if (existsSync(serverPublic)) {
  app.use(
    express.static(serverPublic, {
      // Son binarios versionados con la dependencia: no cambian sin un
      // npm install de por medio.
      maxAge: "7d",
      immutable: true,
    }),
  );
}

// --------------------------------------------------------------------------
// Cliente compilado (modo tunel). En desarrollo local lo sirve Vite.
// --------------------------------------------------------------------------
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api") || req.path.startsWith("/matchmake")) return next();
    res.sendFile(join(webDist, "index.html"), (error) => {
      if (error) next();
    });
  });
}

gameServer.define("aula", AulaRoom);

await gameServer.listen(PORT);

console.log(`\n  Aula EAN Visual - servidor de la fase 1`);
console.log(`  API y Colyseus   http://localhost:${PORT}`);
console.log(`  Cliente          ${existsSync(webDist) ? `http://localhost:${PORT}` : "http://localhost:5173 (Vite)"}`);
console.log(`  Voz              ${voiceEnabled ? LIVEKIT_URL : "DESACTIVADA - falta configurar LiveKit en .env"}`);
console.log(`\n  CODIGO DE PROFESOR:  ${TEACHER_CODE}`);
if (TEACHER_CODE_IS_GENERATED) {
  console.log(`  (generado al arrancar y distinto en cada reinicio.`);
  console.log(`   Fijalo con TEACHER_CODE=... en el .env para que no cambie.)`);
}
console.log("");
