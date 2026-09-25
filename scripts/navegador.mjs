/**
 * Prueba de humo en un navegador real.
 *
 * Recorre lo que hace una persona: crear el salon, armarlo con los paneles de
 * la escena -entorno 360, sacar una pieza, ponerla sobre la mesa-, abrirlo, y
 * entrar como estudiante. Reporta errores de consola y peticiones fallidas.
 * Sin esto, un fallo en el render 3D solo se ve como una pantalla negra.
 *
 * Los paneles del editor viven dentro del lienzo, asi que no hay nodos del
 * DOM que pulsar. Se usa la sonda que el propio editor publica en desarrollo
 * (window.__aulaWidgets) para saber donde cae cada control en pantalla.
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
    // El 409 del salon a medio armar es la respuesta correcta, no un fallo:
    // asi es como el estudiante que llega antes se queda esperando.
    if (r.status() >= 400 && r.status() !== 409 && !RUIDO.test(r.url())) {
      errores.push(`[${etiqueta}:red] HTTP ${r.status()} ${r.url()}`);
    }
  });
}

/**
 * Un paso del recorrido.
 *
 * Al fallar deja una captura y el texto que hubiera en pantalla: un paso que
 * solo dice "fallo" obliga a reproducirlo a mano para saber que paso.
 */
let pagActual = null;
const paso = async (label, fn) => {
  process.stdout.write(`  ${label}... `);
  try {
    await fn();
    console.log("ok");
  } catch (e) {
    console.log("FALLO");
    let contexto = "";
    if (pagActual) {
      const nombre = `fallo-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      try {
        await pagActual.screenshot({ path: resolve(shots, `${nombre}.png`) });
        contexto = await pagActual.evaluate(() => {
          const error = document.querySelector(".error, .crash-card")?.textContent ?? "";
          const estado = document.querySelector(".join-card, .hud-top")?.textContent ?? "";
          return `${error} | ${estado}`.trim().slice(0, 300);
        });
      } catch {
        contexto = "(no se pudo inspeccionar la pagina)";
      }
      contexto = `\n         en pantalla: ${contexto}\n         captura: .capturas/${nombre}.png`;
    }
    errores.push(`[paso: ${label}] ${e.message}${contexto}`);
  }
};

/** Pulsa el primer boton del DOM cuyo texto contenga `fragmento`. */
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
// Profesor: crea el salon y lo arma con el mouse.
// ========================================================================
console.log(`\nAbriendo ${APP_URL}\n`);
console.log("Profesor");

const profe = await browser.newPage();
await profe.setViewport({ width: 1280, height: 800 });
vigilar(profe, "profe");
pagActual = profe;

const capturar = (nombre) => profe.screenshot({ path: resolve(shots, `${nombre}.png`) });

/** Donde cae en pantalla un control de la interfaz espacial. */
const donde = async (id) => {
  const sitio = await profe.evaluate((wid) => {
    const probe = window.__aulaWidgets;
    if (typeof probe !== "function") return null;
    return probe()[wid] ?? null;
  }, id);
  if (!sitio) throw new Error(`el control "${id}" no esta en pantalla`);
  return sitio;
};

/** Apunta a un control y lo pulsa: con mouse, pulsar es cerrar la mano. */
const pulsarWidget = async (id) => {
  const sitio = await donde(id);
  await profe.mouse.move(sitio.x, sitio.y);
  await esperar(120);
  await profe.mouse.down();
  await esperar(120);
  await profe.mouse.up();
  await esperar(250);
};

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

await paso("crear el salon con nombre y cupo", async () => {
  await profe.type("#code", CODE);
  await profe.type("#roomName", "Mantenimiento de valvulas");
  // Seleccionar y reemplazar: escribir sin mas dejaria "54".
  await profe.click("#students", { clickCount: 3 });
  await profe.keyboard.press("Backspace");
  await profe.type("#students", "4");
  await pulsar(profe, "Crear sal");
  await profe.waitForSelector(".pin-show b", { timeout: 15000 });
});

const pin = await profe.$eval(".pin-show b", (el) => el.textContent.trim()).catch(() => "?");
console.log(`     PIN del salon: ${pin}`);

await paso("el resumen muestra el cupo que se pidio", async () => {
  const texto = await profe.$eval(".summary", (el) => el.textContent ?? "");
  if (!texto.includes("4") || !texto.includes("5")) {
    throw new Error(`esperaba 4 estudiantes y cupo 5, dice: "${texto}"`);
  }
});
await capturar("2-salon-creado");

await paso("entrar a armar el salon", async () => {
  await profe.type("#alias", "Profe");
  await pulsar(profe, "Mouse");
  await pulsar(profe, "Entrar a armar");
  await profe.waitForSelector("canvas", { timeout: 20000 });
  await esperar(3000);
});
await capturar("3-editor");

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

await paso("los paneles del editor estan ahi", async () => {
  const controles = await profe.evaluate(() =>
    typeof window.__aulaWidgets === "function" ? Object.keys(window.__aulaWidgets()) : [],
  );
  if (controles.length === 0) throw new Error("la interfaz espacial no registro ningun control");
  const faltan = ["add-box", "env-apply", "slider-yaw", "open-preview"].filter(
    (id) => !controles.includes(id),
  );
  if (faltan.length) throw new Error(`faltan controles: ${faltan.join(", ")}`);
  console.log(`\n     ${controles.length} controles: ${controles.join(", ")}`);
  process.stdout.write("  ");
});

// --- entorno 360 --------------------------------------------------------
await paso("elegir un entorno 360", async () => {
  await pulsarWidget("env-apply");
  // La HDRI pesa ~1,7 MB: se le da tiempo y se comprueba que llego mirando
  // el estado de la sala, no la imagen.
  await profe.waitForFunction(
    () => {
      const probe = window.__aulaWidgets?.();
      // "Usar este" se deshabilita -y desaparece de la sonda- cuando el
      // entorno que muestra el carrusel ya es el que esta puesto.
      return probe && !probe["env-apply"];
    },
    { timeout: 45000, polling: 500 },
  );
  await esperar(2500);
});
await capturar("4-entorno-puesto");

await paso("girar el entorno con un deslizador", async () => {
  const riel = await donde("slider-yaw");
  await profe.mouse.move(riel.x, riel.y);
  await profe.mouse.down();
  await profe.mouse.move(riel.x + 120, riel.y, { steps: 12 });
  await esperar(400);
  await profe.mouse.up();
  await esperar(300);
});
await capturar("5-entorno-girado");

// El mismo recorte con la mesa vacia, para poder comparar. Sin el, no hay
// forma de distinguir "la pieza no se dibuja" de "no la distingo en una
// captura de 1280 pixeles".
await profe.screenshot({
  path: resolve(shots, "7a-mesa-vacia.png"),
  clip: { x: 510, y: 340, width: 260, height: 260 },
});

// --- sacar una pieza y ponerla en la mesa -------------------------------
await paso("sacar un cubo del panel de objetos", async () => {
  await pulsarWidget("add-box");
  // La pieza nace y se engancha a la mano sola: "Tienes:" solo aparece
  // cuando el servidor confirma que es suya, asi que verlo prueba el camino
  // completo de ida y vuelta.
  await hudDice(profe, "Tienes:");
});
await capturar("6-pieza-en-la-mano");

await paso("llevarla a la mesa y soltarla", async () => {
  // El centro del lienzo mira a la mesa: apuntar ahi es apuntar al tablero.
  await profe.mouse.move(640, 470, { steps: 12 });
  await esperar(500);
  // La pieza viene en la mano sin que nadie haya cerrado el puno: se suelta
  // abriendo la mano, que con mouse es pulsar y soltar.
  await profe.mouse.down();
  await esperar(150);
  await profe.mouse.up();
  await esperar(900);
  const texto = await profe.$eval(".hud-bottom", (el) => el.textContent ?? "");
  if (texto.includes("Tienes:")) throw new Error("no la solto al levantar el boton");
});
await capturar("7-pieza-en-la-mesa");

await paso("la pieza quedo apoyada en el tablero y se ve", async () => {
  const piezas = await profe.evaluate(() =>
    typeof window.__aulaObjetos === "function" ? window.__aulaObjetos() : {},
  );
  const [id, pieza] = Object.entries(piezas)[0] ?? [];
  if (!pieza) throw new Error("la escena no tiene ninguna pieza agarrable");
  console.log(
    `\n     ${id} en x=${pieza.world.x.toFixed(2)} y=${pieza.world.y.toFixed(2)} ` +
      `z=${pieza.world.z.toFixed(2)}, en pantalla (${Math.round(pieza.x)}, ${Math.round(pieza.y)})`,
  );
  process.stdout.write("  ");
  // Un recorte alrededor de la pieza. Una pieza de 18 cm a dos metros ocupa
  // unos sesenta pixeles en una captura de pantalla completa: ahi no se
  // distingue si esta puesta, si esta hundida en la mesa o si no se dibuja.
  await profe.screenshot({
    path: resolve(shots, "7b-pieza-de-cerca.png"),
    clip: { x: pieza.x - 130, y: pieza.y - 130, width: 260, height: 260 },
  });
  // El tablero esta a 0,76 y el cubo mide 0,18: apoyado, su centro va a 0,85.
  if (Math.abs(pieza.world.y - 0.85) > 0.02) {
    throw new Error(`no esta sobre el tablero: y=${pieza.world.y.toFixed(3)}`);
  }
  if (!pieza.visible || !pieza.attached) {
    throw new Error("la malla de la pieza no esta viva en la escena");
  }
  if (pieza.size < 0.01) throw new Error(`la geometria es degenerada: ${pieza.size}`);
  // Un NaN en el estado -un giro que el servidor nunca asigno, por ejemplo-
  // llena de NaN la matriz del objeto. La pieza sigue en la escena, en su
  // sitio, con su malla, y three la dibuja en cada cuadro sin pintar un solo
  // pixel. Ninguna otra comprobacion de aqui lo nota.
  if (!pieza.finite) throw new Error("la matriz de la pieza tiene valores que no son numeros");
});

// --- abrir el salon -----------------------------------------------------
await paso("revisar y comenzar la sesion", async () => {
  await pulsarWidget("open-preview");
  await esperar(600);
  await capturar("8-vista-previa");
  // El PIN vive en el estado de la sala, no en el navegador del profesor:
  // que aparezca aqui prueba que el salon nacio sabiendolo.
  const salonSabeSuPin = await profe.evaluate(() => {
    const probe = window.__aulaWidgets?.();
    return Boolean(probe && probe["preview-start"]);
  });
  if (!salonSabeSuPin) throw new Error("la vista previa no se abrio");
  await pulsarWidget("preview-start");
  // Al abrir, los paneles del editor desaparecen.
  await profe.waitForFunction(
    () => {
      const probe = window.__aulaWidgets?.();
      return probe && Object.keys(probe).length === 0;
    },
    { timeout: 10000, polling: 300 },
  );
});
await capturar("9-salon-abierto");

// ========================================================================
// Estudiante con camara: verifica el camino que mas se ha roto, MediaPipe
// cargando su WASM dentro del Web Worker.
// ========================================================================
console.log("\nEstudiante con camara");

const alumno = await browser.newPage();
await alumno.setViewport({ width: 1280, height: 800 });
vigilar(alumno, "alumno");
pagActual = alumno;

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
await alumno.screenshot({ path: resolve(shots, "10-estudiante-camara.png") });

await paso("el estudiante ve la escena que armo el profesor", async () => {
  const visto = await alumno.evaluate(
    () => document.querySelector(".hud-top")?.textContent ?? "",
  );
  if (!visto.includes("Mantenimiento")) {
    throw new Error(`el HUD no muestra el nombre del salon: "${visto}"`);
  }
});

await paso("los dos se ven en la sala", async () => {
  await profe.waitForFunction(
    () => (document.querySelector(".hud-top")?.textContent ?? "").includes("En la sala 2"),
    { timeout: 15000 },
  );
});
await capturar("11-dos-participantes");

await browser.close();

console.log("");
if (errores.length === 0) {
  console.log("Sin errores. Capturas en .capturas/");
  process.exit(0);
}
console.log(`${errores.length} problema(s):\n`);
for (const e of errores) console.log(`${e}\n`);
process.exit(1);
