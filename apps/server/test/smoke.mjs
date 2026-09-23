// Prueba de extremo a extremo: dos participantes entran con el mismo PIN,
// uno agarra la valvula y la mueve, el otro debe verla moverse.
import { Client } from "@colyseus/sdk";

// Por defecto prueba el servidor local. Pasale una URL para verificar que el
// tunel transporta tanto la API como el WebSocket de Colyseus:
//   npm run smoke -w @aula/server -- https://algo.trycloudflare.com profe2026
const API = process.argv[2] ?? process.env.AULA_API ?? "http://localhost:2567";
const CODE = process.argv[3] ?? process.env.TEACHER_CODE ?? "profe2026";
console.log("Probando contra:", API, "\n");

const post = async (path, body) => {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.status);
  return j;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const session = await post("/api/sessions", { code: CODE });
console.log("PIN generado:", session.pin);

// El profesor se identifica con la credencial que devolvio la creacion.
const a = await post("/api/join", { pin: session.pin, alias: "Profe", hostToken: session.hostToken });
const b = await post("/api/join", { pin: session.pin, alias: "Estudiante" });

const clientA = new Client(API);
const clientB = new Client(API);
const roomA = await clientA.joinById(a.roomId, { ticket: a.ticket });
const roomB = await clientB.joinById(b.roomId, { ticket: b.ticket });
await sleep(400);

console.log("A sessionId:", roomA.sessionId, "| B sessionId:", roomB.sessionId);
console.log("participantes vistos por B:", roomB.state.players.size);
console.log("objetos:", [...roomB.state.objects.keys()].join(", "));

const meA = roomA.state.players.get(roomA.sessionId);
const meB = roomB.state.players.get(roomB.sessionId);
console.log(`punto de A = ${meA.spotId} (rol ${meA.role}) | punto de B = ${meB.spotId}`);
console.log("color de A:", meA.color, "| voiceId presente:", Boolean(meA.voiceId));

// --- pose ---------------------------------------------------------------
roomA.send("pose", [-0.1, 1.62, -0.6, 0.2, -0.05, 1, 3, 0.4, 1.1, -1.2, 1, 1, -0.3, 1.0, -1.0]);
await sleep(300);
const aSeenByB = roomB.state.players.get(roomA.sessionId);
console.log(
  `pose de A vista por B: cabeza y=${aSeenByB.hy.toFixed(3)} | mano izq gesto=${aSeenByB.left.gesture} tracked=${aSeenByB.left.tracked} x=${aSeenByB.left.x.toFixed(3)}`,
);

// --- agarrar y mover ----------------------------------------------------
roomA.send("grab", { id: "valvula" });
await sleep(250);
console.log("valvula heldBy === A:", roomB.state.objects.get("valvula").heldBy === roomA.sessionId);

// B intenta robarla: el servidor debe negarlo.
roomB.send("grab", { id: "valvula" });
await sleep(250);
console.log("B no pudo robarla:", roomB.state.objects.get("valvula").heldBy === roomA.sessionId);

// B intenta moverla sin tenerla: no debe pasar nada.
const before = roomB.state.objects.get("valvula").x;
roomB.send("move", { id: "valvula", p: [3, 1, 3] });
await sleep(250);
console.log("B no pudo moverla:", Math.abs(roomB.state.objects.get("valvula").x - before) < 0.01);

// A la mueve de verdad.
roomA.send("move", { id: "valvula", p: [0.8, 1.15, -1.2] });
await sleep(300);
const v = roomB.state.objects.get("valvula");
console.log(`B ve la valvula en x=${v.x.toFixed(3)} y=${v.y.toFixed(3)} z=${v.z.toFixed(3)}`);

// Fuera de la sala: el servidor debe recortar.
roomA.send("move", { id: "valvula", p: [99, 99, 99] });
await sleep(300);
const clamped = roomB.state.objects.get("valvula");
console.log(`recorte a los limites: x=${clamped.x.toFixed(2)} y=${clamped.y.toFixed(2)} (sala +-4, alto 3)`);

// --- mesa bloqueada -----------------------------------------------------
roomA.send("grab", { id: "mesa" });
await sleep(250);
console.log("mesa bloqueada sigue libre:", roomB.state.objects.get("mesa").heldBy === "");

// --- mano arriba --------------------------------------------------------
roomA.send("raiseHand", { v: true });
await sleep(250);
console.log("B ve la mano levantada de A:", roomB.state.players.get(roomA.sessionId).handRaised);

// --- salida: debe soltar lo que tenia -----------------------------------
await roomA.leave();
await sleep(500);
console.log("al salir A, la valvula quedo libre:", roomB.state.objects.get("valvula").heldBy === "");
console.log("participantes tras la salida:", roomB.state.players.size);

// --- ticket reusado -----------------------------------------------------
try {
  const clientC = new Client(API);
  await clientC.joinById(a.roomId, { ticket: a.ticket });
  console.log("FALLO: el ticket se pudo reusar");
} catch {
  console.log("ticket de un solo uso: reuso rechazado");
}

await roomB.leave();
console.log("\nlisto");
process.exit(0);
