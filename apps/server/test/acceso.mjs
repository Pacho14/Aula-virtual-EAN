/**
 * Control de acceso y vida del salon.
 *
 *   node apps/server/test/acceso.mjs [urlBase] [codigoProfesor]
 */
import { Client } from "@colyseus/sdk";

const API = process.argv[2] ?? process.env.AULA_API ?? "http://localhost:2567";
const CODE = process.argv[3] ?? process.env.TEACHER_CODE ?? "profe2026";

const call = async (path, body) => {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fallos = 0;
const check = (ok, label, extra = "") => {
  console.log(`${ok ? "  OK " : "FALLO"}  ${label}${extra ? ` -> ${extra}` : ""}`);
  if (!ok) fallos++;
};

console.log(`Probando contra ${API}\n`);

// --- solo el profesor crea salones --------------------------------------
console.log("Creacion de salones");
const sinCodigo = await call("/api/sessions", {});
check(sinCodigo.status === 401, "sin codigo se rechaza", `HTTP ${sinCodigo.status}`);

const codigoMalo = await call("/api/sessions", { code: "incorrecto" });
check(codigoMalo.status === 401, "codigo incorrecto se rechaza", `HTTP ${codigoMalo.status}`);

const creado = await call("/api/sessions", {
  code: CODE,
  salon: 1,
  roomName: "Taller",
  students: 3,
});
check(creado.status === 200, "con el codigo correcto se crea", `PIN ${creado.body.pin}`);
check(Boolean(creado.body.hostToken), "devuelve credencial de profesor");

const { pin, hostToken } = creado.body;

// --- mientras el profesor arma la escena, el salon no recibe ------------
console.log("\nFase de edicion");
const antesDeAbrir = await call("/api/join", { pin, alias: "Impaciente" });
check(antesDeAbrir.status === 409, "un estudiante no entra al salon a medio armar", `HTTP ${antesDeAbrir.status}`);

const armador = await call("/api/join", { pin, alias: "Profe", hostToken });
check(armador.status === 200, "el profesor si entra a armarlo", `HTTP ${armador.status}`);

const cArmador = new Client(API);
const salaArmador = await cArmador.joinById(armador.body.roomId, { ticket: armador.body.ticket });
await sleep(400);
salaArmador.send("publish");
await sleep(400);
check(salaArmador.state.phase === "live", "al pulsar comenzar el salon abre", salaArmador.state.phase);
await salaArmador.leave();
await sleep(300);

// --- el salon sobrevive sin nadie adentro -------------------------------
console.log("\nVida del salon");
console.log("  esperando 25 s con el salon vacio...");
await sleep(25000);

const tarde = await call("/api/join", { pin, alias: "Estudiante" });
check(tarde.status === 200, "un estudiante entra 25 s despues de crearlo", `HTTP ${tarde.status}`);

// --- el rol no lo elige el cliente --------------------------------------
console.log("\nRoles");
check(tarde.body.role === "student", "sin credencial entra como estudiante", tarde.body.role);

const colado = await call("/api/join", { pin, alias: "Colado", role: "teacher" });
check(
  colado.body.role === "student",
  "pedir role:teacher en el cuerpo no sirve de nada",
  colado.body.role,
);

const tokenFalso = await call("/api/join", { pin, alias: "Colado2", hostToken: "inventado" });
check(tokenFalso.body.role === "student", "credencial inventada no da el rol", tokenFalso.body.role);

const profe = await call("/api/join", { pin, alias: "Profe", hostToken });
check(profe.body.role === "teacher", "con la credencial real si es profesor", profe.body.role);

// --- la clase funciona de verdad ----------------------------------------
console.log("\nLa clase");
const cProfe = new Client(API);
const cAlumno = new Client(API);
const salaProfe = await cProfe.joinById(profe.body.roomId, { ticket: profe.body.ticket });
const salaAlumno = await cAlumno.joinById(tarde.body.roomId, { ticket: tarde.body.ticket });
await sleep(500);

const yoProfe = salaProfe.state.players.get(salaProfe.sessionId);
const yoAlumno = salaAlumno.state.players.get(salaAlumno.sessionId);
check(yoProfe.role === "teacher" && yoProfe.spotId === "prof", "el profesor toma el punto del frente", yoProfe.spotId);
check(yoAlumno.role === "student" && yoAlumno.spotId !== "prof", "el estudiante toma un punto de alumno", yoAlumno.spotId);
check(salaAlumno.state.players.size === 2, "ambos se ven en la misma sala", `${salaAlumno.state.players.size} participantes`);

// --- el salon sigue en pie aunque todos salgan --------------------------
await salaProfe.leave();
await salaAlumno.leave();
await sleep(2500);
const revuelta = await call("/api/join", { pin, alias: "Rezagado" });
check(revuelta.status === 200, "se puede volver a entrar tras quedar vacio", `HTTP ${revuelta.status}`);

// El salon es uno de tres: dejarlo abierto bloquearia la siguiente prueba.
const cierre = await call("/api/join", { pin, alias: "Profe", hostToken });
if (cierre.status === 200) {
  const cCierre = new Client(API);
  const salaCierre = await cCierre.joinById(cierre.body.roomId, { ticket: cierre.body.ticket });
  await sleep(300);
  salaCierre.send("close");
  await sleep(600);
}

console.log(fallos === 0 ? "\nTodo pasa." : `\n${fallos} comprobacion(es) fallaron.`);
process.exit(fallos === 0 ? 0 : 1);
