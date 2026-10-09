/**
 * Copia los binarios WASM de MediaPipe a apps/server/public/mediapipe/wasm.
 *
 * Los sirve el servidor, no Vite, por dos razones:
 *
 * 1. MediaPipe carga su runtime con un import() dinamico. Si los archivos
 *    viven en el public/ de Vite, Vite lo rechaza: "This file is in /public
 *    and should not be imported from source code". Fuera de su publicDir el
 *    conflicto desaparece.
 * 2. Es como quedan en produccion de todos modos: detras del tunel el
 *    servidor sirve la aplicacion y estos archivos desde el mismo origen.
 *
 * Se sirven desde el propio origen en vez de un CDN para que la sala arranque
 * en una red de campus que bloquee dominios externos.
 */
import { cp, mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const destination = resolve(root, "apps/server/public/mediapipe/wasm");

/**
 * El modelo de puntos de la mano, por el mismo motivo que el WASM.
 *
 * Son 7,5 MB que, viniendo del CDN de Google, se bajaban en cada arranque en
 * frio: en el wifi de un campus eso es el primer cuello de toda la
 * experiencia, y en una red que filtre dominios externos no arranca en
 * absoluto. Sirviendolo del propio origen, la sala abre con lo que ya esta en
 * el servidor.
 *
 * No va al repositorio -la carpeta esta en .gitignore por peso-, asi que lo
 * trae este script, que corre en postinstall. Si no hay red, se avisa y no se
 * falla: el cliente tiene el CDN como respaldo (ver `ATTEMPTS` en
 * input/cameraSource.ts) y mas vale arrancar lento que no arrancar.
 */
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const modelDir = resolve(root, "apps/server/public/mediapipe/model");
const modelFile = resolve(modelDir, "hand_landmarker.task");
/** Por debajo de esto el archivo esta a medias o es una pagina de error. */
const MODEL_MIN_BYTES = 1_000_000;

// El paquete no expone su carpeta wasm en "exports", asi que require.resolve
// no sirve: se busca node_modules subiendo directorios, como hace Node.
function findWasmDir(from) {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, "node_modules/@mediapipe/tasks-vision/wasm");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const source = findWasmDir(here);
if (!source) {
  console.error("[mediapipe] No se encontro @mediapipe/tasks-vision. Corre npm install.");
  process.exit(1);
}

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

const files = await readdir(destination);
console.log(`[mediapipe] ${files.length} archivos en apps/server/public/mediapipe/wasm`);

await traerModelo();

/**
 * Baja el modelo si no esta ya, y lo deja completo o no lo deja.
 *
 * Se escribe en un temporal y se renombra al final. Sin eso, una descarga
 * cortada a la mitad deja un .task truncado del tamano suficiente para que la
 * siguiente corrida lo de por bueno, y entonces el fallo sale mucho despues y
 * en otro sitio: MediaPipe reventando al crear el detector.
 */
async function traerModelo() {
  if (existsSync(modelFile)) {
    const { size } = await stat(modelFile);
    if (size >= MODEL_MIN_BYTES) {
      console.log(`[mediapipe] modelo ya presente (${(size / 1e6).toFixed(1)} MB)`);
      return;
    }
    console.warn("[mediapipe] el modelo que habia estaba a medias; se baja otra vez");
  }

  await mkdir(modelDir, { recursive: true });
  const parcial = `${modelFile}.parcial`;
  try {
    const response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength < MODEL_MIN_BYTES) {
      throw new Error(`solo llegaron ${bytes.byteLength} bytes`);
    }
    await writeFile(parcial, bytes);
    await rename(parcial, modelFile);
    console.log(`[mediapipe] modelo descargado (${(bytes.byteLength / 1e6).toFixed(1)} MB)`);
  } catch (error) {
    // Avisar y seguir: el cliente tiene el CDN como respaldo. Fallar aqui
    // dejaria sin instalar el repositorio entero por no tener red.
    console.warn(
      `[mediapipe] no se pudo bajar el modelo (${error.message}). ` +
        "El cliente lo pedira al CDN de Google, que es mas lento y necesita salida a internet.",
    );
  }
}
