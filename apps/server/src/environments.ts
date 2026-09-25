/**
 * Catalogo de entornos 360.
 *
 * Lo escribe `npm run assets:hdri` al reducir la carpeta HDRI/, y el servidor
 * lo lee una vez al arrancar. Existe sobre todo para validar: el id del
 * entorno viaja en el estado de la sala y todos los clientes lo convierten en
 * una URL, asi que un id que el profesor invente llegaria a los estudiantes
 * como una peticion a una ruta cualquiera. Solo pasan los que estan aqui.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Environment {
  id: string;
  label: string;
  file: string;
  thumb: string;
  width: number;
  height: number;
  bytes: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(here, "../public/hdri/index.json");

const environments: Environment[] = load();

function load(): Environment[] {
  if (!existsSync(indexPath)) {
    console.warn(
      "[entornos] no hay apps/server/public/hdri/index.json. Corre npm run assets:hdri.",
    );
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as Environment[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[entornos] index.json ilegible:", error);
    return [];
  }
}

export function listEnvironments(): Environment[] {
  return environments;
}

/** "" es valido: es la habitacion en blanco, sin entorno. */
export function isKnownEnvironment(id: string): boolean {
  return id === "" || environments.some((environment) => environment.id === id);
}
