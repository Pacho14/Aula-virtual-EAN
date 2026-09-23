/**
 * Prueba de humo en un navegador real.
 *
 * Recorre lo que hace una persona -crear el salon, entrar, apuntar, agarrar y
 * soltar- y reporta errores de consola y peticiones fallidas. Sin esto, un
 * fallo en el render 3D solo se ve como una pantalla negra.
 *
 * Los textos de los botones se buscan por fragmentos sin tildes a proposito:
 * asi la prueba no se rompe si alguien reescribe el archivo con otra
 * codificacion.
 *
 *   node scripts/navegador.mjs [url] [codigoProfesor]
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(here, "../.capturas");

const APP_URL = process.argv[2] ?? "http://localhost:5173";
const CODE = process.argv[3] ?? process.env.TEACHER_CODE ?? "profe2026";

const CHROME = [
  process.env.CHROME_PATH,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));

if (!CHROME) {
  console.error("No se encontro Chrome. Pasa la ruta en CHROME_PATH.");
  process.exit(1);
}

mkdirSync(shots, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "shell",
  args: [
    "--no-sandbox",
    "--use-gl=swiftshader", // WebGL sin GPU real
    "--enable-unsafe-swiftshader",
    "--use-fake-ui-for-media-stream", // acepta la camara sin preguntar
    "--use-fake-device-for-media-stream",
    "--window-size=1280,800",
  ],
});

const errores = [];
const RUIDO = /swiftshader|webgl|devtools|favicon/i;

function vigilar(pagina, etiqueta) {
  pagina.on("console", (msg) => {
    if (msg.type() !== "error" && msg.type() !== "warning") return;
    if (RUIDO.test(msg.text())) return;
    errores.push(`[${etiqueta}:consola] ${msg.text()}`);
  });
  pagina.on("pageerror", (e) =>
    errores.push(`[${etiqueta}:excepcion] ${e.message}\n${e.stack ?? ""}`),
  );
  pagina.on("requestfailed", (r) => {
    if (RUIDO.test(r.url())) return;
    errores.push(`[${etiqueta}:red] ${r.url()} -> ${r.failure()?.errorText}`);
  });
  pagina.on("response", (r) => {
    if (r.status() >= 400 && !RUIDO.test(r.url())) {
      errores.push(`[${etiqueta}:red] HTTP ${r.status()} ${r.url()}`);
    }
  });
}

const paso = async (label, fn) => {
  process.stdout.write(`  ${label}... `);
  try {
    await fn();
    console.log("ok");
  } catch (e) {
    console.log("FALLO");
    errores.push(`[paso: ${label}] ${e.message}`);
  }
};

/** Pulsa el primer boton cuyo texto contenga `fragmento`. */
const pulsar = (pagina, fragmento) =>
  pagina.evaluate((f) => {
    const boton = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(f),
    );
    if (!boton) throw new Error(`no hay boton con "${f}"`);
    boton.click();
  }, fragmento);

const hudDice = (pagina, fragmento) =>
  pagina.waitForFunction(
    (f) => (document.querySelector(".hud-bottom")?.textContent ?? "").includes(f),
    { timeout: 8000 },
    fragmento,
  );

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ========================================================================
// Profesor: crea el salon y trabaja con el mouse.
// ========================================================================
console.log(`\nAbriendo ${APP_URL}\n`);
console.log("Profesor");

const profe = await browser.newPage();
await profe.setViewport({ width: 1280, height: 800 });
vigilar(profe, "profe");

const capturar = (nombre) => profe.screenshot({ path: resolve(shots, `${nombre}.png`) });

await paso("cargar la pagina", async () => {
  await profe.goto(APP_URL, { waitUntil: "networkidle2", timeout: 40000 });
  await profe.waitForSelector(".join-card", { timeout: 15000 });
});
await capturar("1-inicio");

await paso("pestana de profesor", async () => {
  await profe.evaluate(() => {
    [...document.querySelectorAll('[role="tab"]')]
      .find((b) => (b.textContent ?? "").includes("profesor"))
      ?.click();
  });
  await profe.waitForSelector("#code", { timeout: 8000 });
});

await paso("crear el salon", async () => {
  await profe.type("#code", CODE);
  await pulsar(profe, "Crear sal");
  await profe.waitForSelector(".pin-show b", { timeout: 15000 });
});

const pin = await profe.$eval(".pin-show b", (el) => el.textContent.trim()).catch(() => "?");
console.log(`     PIN del salon: ${pin}`);
await capturar("2-salon-creado");

await paso("entrar en modo mouse", async () => {
  await profe.type("#alias", "Profe");
  await pulsar(profe, "Mouse");
  await pulsar(profe, "Entrar a dar la clase");
  await profe.waitForSelector("canvas", { timeout: 20000 });
  await esperar(3000);
});
await capturar("3-sala");

await paso("el lienzo dibuja algo", async () => {
  const info = await profe.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return { ok: false, motivo: "no hay canvas" };
    const crash = document.querySelector(".crash-card h1");
    if (crash) return { ok: false, motivo: `barrera de errores: ${crash.textContent}` };
    return {
      ok: canvas.width > 0 && canvas.height > 0,
      w: canvas.width,
      h: canvas.height,
      hud: Boolean(document.querySelector(".hud-bottom")),
    };
  });
  if (!info.ok) throw new Error(info.motivo ?? "lienzo vacio");
  if (!info.hud) throw new Error("el HUD no aparecio");
  console.log(`\n     lienzo ${info.w}x${info.h}, HUD presente`);
  process.stdout.write("  ");
});

/** Barre el lienzo hasta que el HUD diga que esta apuntando a algo. */
async function apuntarAlgo() {
  for (let y = 360; y <= 500; y += 20) {
    for (let x = 380; x <= 900; x += 20) {
      await profe.mouse.move(x, y);
      await esperar(60);
      const texto = await profe.$eval(".hud-bottom", (el) => el.textContent ?? "");
      const m = texto.match(/Apuntando:\s*(\S+)/);
      if (m) return { x, y, id: m[1] };
    }
  }
  return null;
}

let objetivo = null;
await paso("apuntar a un objeto", async () => {
  objetivo = await apuntarAlgo();
  if (!objetivo) throw new Error("el rayo no encontro ningun objeto agarrable");
  console.log(`\n     apuntando a "${objetivo.id}" en (${objetivo.x}, ${objetivo.y})`);
  process.stdout.write("  ");
});
await capturar("4-apuntando");

await paso("agarrarlo (lo concede el servidor)", async () => {
  await profe.mouse.down();
  // "Tienes:" solo aparece cuando el estado del servidor confirma heldBy, asi
  // que verlo prueba el camino completo de ida y vuelta.
  await hudDice(profe, "Tienes:");
});

await paso("moverlo y soltarlo", async () => {
  await profe.mouse.move(objetivo.x - 140, objetivo.y - 60, { steps: 16 });
  await esperar(500);
  await capturar("5-arrastrando");
  await profe.mouse.up();
  await esperar(700);
  const texto = await profe.$eval(".hud-bottom", (el) => el.textContent ?? "");
  if (texto.includes("Tienes:")) throw new Error("no lo solto al levantar el boton");
});
await capturar("6-tras-soltar");

// ========================================================================
// Estudiante con camara: verifica el camino que mas se ha roto, MediaPipe
// cargando su WASM dentro del Web Worker.
// ========================================================================
console.log("\nEstudiante con camara");

const alumno = await browser.newPage();
await alumno.setViewport({ width: 1280, height: 800 });
vigilar(alumno, "alumno");

await paso("entrar con el PIN", async () => {
  await browser
    .defaultBrowserContext()
    .overridePermissions(new URL(APP_URL).origin, ["camera", "microphone"]);
  await alumno.goto(APP_URL, { waitUntil: "networkidle2", timeout: 40000 });
  await alumno.waitForSelector("#pin", { timeout: 15000 });
  await alumno.type("#pin", pin);
  await alumno.type("#alias", "Estudiante");
  await pulsar(alumno, "Manos con c");
  await pulsar(alumno, "Entrar al sal");
  await alumno.waitForSelector("canvas", { timeout: 90000 });
});

await paso("el detector de manos arranca", async () => {
  // Con camara falsa no hay manos que detectar, pero el detector debe correr:
  // si el WASM no carga, el contador se queda en cero para siempre.
  await alumno.waitForFunction(
    () => {
      const t = document.querySelector(".hud-bottom")?.textContent ?? "";
      const m = t.match(/(\d+)\s*det/);
      return m && Number(m[1]) > 0;
    },
    { timeout: 60000, polling: 500 },
  );
  const fps = await alumno.$eval(
    ".hud-bottom",
    (el) => el.textContent?.match(/(\d+)\s*det/)?.[1],
  );
  console.log(`\n     deteccion de manos a ${fps} fps`);
  process.stdout.write("  ");
});
await alumno.screenshot({ path: resolve(shots, "7-estudiante-camara.png") });

await paso("los dos se ven en la sala", async () => {
  await profe.waitForFunction(
    () => (document.querySelector(".hud-top")?.textContent ?? "").includes("En la sala 2"),
    { timeout: 15000 },
  );
});
await capturar("8-dos-participantes");

await browser.close();

console.log("");
if (errores.length === 0) {
  console.log("Sin errores. Capturas en .capturas/");
  process.exit(0);
}
console.log(`${errores.length} problema(s):\n`);
for (const e of errores) console.log(`${e}\n`);
process.exit(1);
