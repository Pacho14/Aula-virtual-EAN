// Prueba de extremo a extremo del salon armado por el profesor.
//
// El profesor crea el salon, lo arma a solas -entorno y piezas-, lo abre, y
// solo entonces entra un estudiante. Se comprueba lo que el servidor tiene que
// sostener aunque el cliente mande cualquier cosa: quien puede editar, donde
// se puede dejar una pieza y de quien es cada objeto.
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
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
};

const ok = async (path, body) => {
  const r = await post(path, body);
  if (r.status !== 200) throw new Error(`${path} -> ${r.status} ${r.body.error ?? ""}`);
  return r.body;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fallos = 0;
const check = (pasa, label, extra = "") => {
  console.log(`${pasa ? "  OK " : "FALLO"}  ${label}${extra ? ` -> ${extra}` : ""}`);
  if (!pasa) fallos++;
};

// --- el salon se crea con nombre y cupo ---------------------------------
console.log("Creacion");
const session = await ok("/api/sessions", {
  code: CODE,
  roomName: "Mantenimiento de valvulas",
  students: 4,
});
console.log("  PIN generado:", session.pin);
check(session.roomName === "Mantenimiento de valvulas", "guarda el nombre", session.roomName);
check(session.students === 4, "guarda cuantos estudiantes", String(session.students));

// --- mientras se arma, nadie entra --------------------------------------
console.log("\nFase de edicion");
const temprano = await post("/api/join", { pin: session.pin, alias: "Estudiante" });
check(temprano.status === 409, "un estudiante que llega antes recibe espera", `HTTP ${temprano.status}`);
check(temprano.body.waiting === true, "y se le dice que es una espera, no un error");

const profe = await ok("/api/join", {
  pin: session.pin,
  alias: "Profe",
  hostToken: session.hostToken,
});
check(profe.role === "teacher", "el profesor si entra", profe.role);

const scene = profe.scene;
check(scene.spots.length === 5, "cuatro puestos de alumno mas el del profesor", `${scene.spots.length}`);
check(scene.capacity === 5, "el cupo sale del numero de estudiantes", `${scene.capacity}`);
check(scene.assets.length === 1 && scene.assets[0].id === "mesa", "el salon nace con la mesa sola");

const clienteProfe = new Client(API);
const salaProfe = await clienteProfe.joinById(profe.roomId, { ticket: profe.ticket });
await sleep(400);
check(salaProfe.state.phase === "editing", "la sala arranca en edicion", salaProfe.state.phase);
check(salaProfe.state.roomName === "Mantenimiento de valvulas", "el nombre llega en el estado");
// La vista previa muestra el PIN desde dentro de la escena, asi que el salon
// tiene que nacer sabiendoselo y no enterarse por el navegador del profesor.
check(salaProfe.state.pin === session.pin, "el salon lleva su PIN en el estado", salaProfe.state.pin);

// --- entorno 360 --------------------------------------------------------
console.log("\nEntorno");
const catalogo = await fetch(API + "/api/environments").then((r) => r.json());
console.log("  entornos disponibles:", catalogo.map((e) => e.id).join(", ") || "ninguno");

if (catalogo.length > 0) {
  salaProfe.send("env", { id: catalogo[0].id, yaw: 0.4, pitch: -0.2, height: 0.3 });
  await sleep(300);
  check(salaProfe.state.envId === catalogo[0].id, "el entorno elegido queda en el estado", salaProfe.state.envId);
  check(Math.abs(salaProfe.state.envYaw - 0.4) < 0.01, "el giro horizontal viaja", salaProfe.state.envYaw.toFixed(3));
  check(Math.abs(salaProfe.state.envHeight - 0.3) < 0.01, "la altura viaja", salaProfe.state.envHeight.toFixed(3));

  salaProfe.send("env", { id: "../../etc/passwd" });
  await sleep(250);
  check(salaProfe.state.envId === catalogo[0].id, "un entorno inventado se ignora", salaProfe.state.envId);

  salaProfe.send("env", { yaw: 99 });
  await sleep(250);
  check(salaProfe.state.envYaw <= Math.PI / 2 + 0.01, "el giro se recorta a 90 grados", salaProfe.state.envYaw.toFixed(3));
}

// --- sacar piezas del panel de objetos ----------------------------------
console.log("\nPiezas");
let creada = null;
salaProfe.onMessage("spawned", (m) => {
  creada = m.id;
});

salaProfe.send("spawn", { prim: "box" });
await sleep(350);
check(Boolean(creada), "el servidor confirma el id de la pieza nueva", String(creada));
const cubo = salaProfe.state.objects.get(creada);
check(Boolean(cubo), "la pieza esta en el estado");
check(
  Math.abs(cubo.y - (0.76 + cubo.sy / 2)) < 0.01,
  "nace apoyada en el tablero, no flotando",
  `y=${cubo.y.toFixed(3)}`,
);

salaProfe.send("spawn", { prim: "conos" });
await sleep(250);
check(salaProfe.state.objects.size === 2, "una primitiva inventada no crea nada", `${salaProfe.state.objects.size} objetos`);

// --- el iman ------------------------------------------------------------
console.log("\nEl iman");
salaProfe.send("grab", { id: creada });
await sleep(250);
check(salaProfe.state.objects.get(creada).heldBy === salaProfe.sessionId, "el profesor la toma");

// Sobre el tablero: se apoya en el, sin importar la altura que mande el cliente.
salaProfe.send("move", { id: creada, p: [0.2, 9, 0.1] });
await sleep(300);
const sobreMesa = salaProfe.state.objects.get(creada);
check(
  Math.abs(sobreMesa.y - (0.76 + sobreMesa.sy / 2)) < 0.01,
  "sobre la mesa se apoya en el tablero aunque se pida altura 9",
  `y=${sobreMesa.y.toFixed(3)}`,
);

// Lejos: se recorta a la zona y cae al piso.
salaProfe.send("move", { id: creada, p: [99, 99, 99] });
await sleep(300);
const lejos = salaProfe.state.objects.get(creada);
check(
  Math.abs(lejos.x) <= 1.46 && Math.abs(lejos.z) <= 1.11,
  "fuera de la zona se recorta al limite",
  `x=${lejos.x.toFixed(2)} z=${lejos.z.toFixed(2)}`,
);
check(
  Math.abs(lejos.y - lejos.sy / 2) < 0.01,
  "y fuera del tablero se apoya en el piso",
  `y=${lejos.y.toFixed(3)}`,
);

// Al soltar, encaja en la rejilla de 5 cm.
salaProfe.send("move", { id: creada, p: [0.233, 1, 0.087] });
await sleep(250);
salaProfe.send("release", { id: creada });
await sleep(300);
const soltada = salaProfe.state.objects.get(creada);
const enRejilla = Math.abs(soltada.x / 0.05 - Math.round(soltada.x / 0.05)) < 0.02;
check(enRejilla, "al soltarla encaja en la rejilla", `x=${soltada.x.toFixed(4)}`);
check(soltada.heldBy === "", "y queda libre");

// --- la mesa no se toca -------------------------------------------------
salaProfe.send("grab", { id: "mesa" });
await sleep(250);
check(salaProfe.state.objects.get("mesa").heldBy === "", "la mesa bloqueada sigue libre");
salaProfe.send("remove", { id: "mesa" });
await sleep(250);
check(salaProfe.state.objects.has("mesa"), "y no se puede borrar");

// --- abrir el salon -----------------------------------------------------
console.log("\nAbrir el salon");
salaProfe.send("publish");
await sleep(400);
check(salaProfe.state.phase === "live", "la sala pasa a en vivo", salaProfe.state.phase);

const alumno = await ok("/api/join", { pin: session.pin, alias: "Estudiante" });
check(alumno.role === "student", "ahora si entra un estudiante", alumno.role);

const clienteAlumno = new Client(API);
const salaAlumno = await clienteAlumno.joinById(alumno.roomId, { ticket: alumno.ticket });
await sleep(500);
check(salaAlumno.state.players.size === 2, "ambos se ven", `${salaAlumno.state.players.size}`);
check(salaAlumno.state.objects.has(creada), "el estudiante ve la pieza que puso el profesor");
if (catalogo.length > 0) {
  check(salaAlumno.state.envId === catalogo[0].id, "y ve el mismo entorno", salaAlumno.state.envId);
}

// --- el estudiante no edita ---------------------------------------------
console.log("\nAutoridad");
const antes = salaAlumno.state.objects.size;
salaAlumno.send("spawn", { prim: "sphere" });
await sleep(300);
check(salaAlumno.state.objects.size === antes, "un estudiante no saca piezas", `${salaAlumno.state.objects.size}`);

salaAlumno.send("remove", { id: creada });
await sleep(250);
check(salaAlumno.state.objects.has(creada), "ni borra las que hay");

const envAntes = salaAlumno.state.envId;
salaAlumno.send("env", { id: "", yaw: 1 });
await sleep(250);
check(salaAlumno.state.envId === envAntes, "ni cambia el entorno", salaAlumno.state.envId);

// Tampoco despues de abierta: editar es del profesor.
salaProfe.send("spawn", { prim: "sphere" });
await sleep(300);
check(salaProfe.state.objects.size === antes, "ni el profesor, con la clase ya abierta");

// --- pose ---------------------------------------------------------------
console.log("\nPose y objetos");
salaProfe.send("pose", [-0.1, 1.62, -0.6, 0.2, -0.05, 1, 3, 0.4, 1.1, -1.2, 1, 1, -0.3, 1.0, -1.0]);
await sleep(300);
const profeVistoPorAlumno = salaAlumno.state.players.get(salaProfe.sessionId);
check(
  Math.abs(profeVistoPorAlumno.hy - 1.62) < 0.01 && profeVistoPorAlumno.left.gesture === 3,
  "el estudiante ve la pose del profesor",
  `y=${profeVistoPorAlumno.hy.toFixed(3)} gesto=${profeVistoPorAlumno.left.gesture}`,
);

// --- robar un objeto ajeno ----------------------------------------------
salaAlumno.send("grab", { id: creada });
await sleep(250);
check(salaProfe.state.objects.get(creada).heldBy === salaAlumno.sessionId, "el estudiante toma la pieza libre");

salaProfe.send("grab", { id: creada });
await sleep(250);
check(
  salaProfe.state.objects.get(creada).heldBy === salaAlumno.sessionId,
  "y el profesor no se la puede quitar",
);

// --- salir suelta lo que se tenia ---------------------------------------
await salaAlumno.leave();
await sleep(600);
check(salaProfe.state.objects.get(creada).heldBy === "", "al salir, la pieza queda libre");

// --- ticket de un solo uso ----------------------------------------------
try {
  const colado = new Client(API);
  await colado.joinById(profe.roomId, { ticket: profe.ticket });
  check(false, "el ticket se pudo reusar");
} catch {
  check(true, "ticket de un solo uso: reuso rechazado");
}

await salaProfe.leave();
console.log(fallos === 0 ? "\nTodo pasa." : `\n${fallos} comprobacion(es) fallaron.`);
process.exit(fallos === 0 ? 0 : 1);
