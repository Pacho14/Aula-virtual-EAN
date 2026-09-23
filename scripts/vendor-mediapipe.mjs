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
import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const destination = resolve(root, "apps/server/public/mediapipe/wasm");

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
