/**
 * Prepara las HDRI de la carpeta HDRI/ para servirlas desde el navegador.
 *
 * Las originales son 4K y pesan ~25 MB cada una: 78 MB entre las tres, contra
 * un presupuesto de descarga de 15 MB (seccion 13). Tal cual no caben ni en el
 * bundle ni en el repositorio.
 *
 * De cada .hdr salen dos archivos a apps/server/public/hdri/:
 *
 *   <id>.hdr   equirectangular 1024x512 en RGBE con RLE, ~1,5 MB. Es lo que
 *              aguanta un celular de gama media como mapa de entorno sin
 *              comerse los 30 fps. Se descarga solo al elegir el entorno.
 *   <id>.png   miniatura 256x128 tonemapeada, unas decenas de KB. Es lo unico
 *              que baja el carrusel al abrirse.
 *
 * Todo en Node puro: esta maquina no tiene ffmpeg ni ImageMagick, y una
 * dependencia nativa mas seria una razon mas para que el proyecto no compile
 * en la maquina de al lado.
 */
import { deflateSync } from "node:zlib";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const source = resolve(root, "HDRI");
const destination = resolve(root, "apps/server/public/hdri");

/** Tamano de trabajo. Equirectangular es siempre 2:1. */
const OUT_W = 1024;
const OUT_H = 512;
/** Miniatura del carrusel. Divisor exacto del tamano de trabajo. */
const THUMB_W = 256;
const THUMB_H = 128;

// El cuerpo del script va en main() y se llama al final del archivo: arriba,
// las tablas y constantes declaradas mas abajo todavia no existen.
async function main() {
  if (!existsSync(source)) {
    console.log("[hdri] no hay carpeta HDRI/. Nada que preparar.");
    return;
  }

  const files = (await readdir(source)).filter((name) => /\.hdr$/i.test(name)).sort();
  if (files.length === 0) {
    console.log("[hdri] la carpeta HDRI/ no tiene archivos .hdr.");
    return;
  }

  await mkdir(destination, { recursive: true });

  // `npm run dev` pasa por aqui cada vez. Reducir 78 MB de 4K toma medio
  // minuto, asi que solo se rehace lo que cambio. `--force` lo rehace todo.
  const force = process.argv.includes("--force");

  const index = [];
  for (const name of files) {
    const id = slug(name);
    const origin = join(source, name);
    const target = join(destination, id + ".hdr");

    if (!force && (await isFresh(origin, target))) {
      const { size } = await stat(target);
      index.push(entry(id, name, size));
      console.log("[hdri] " + id + " ya estaba al dia");
      continue;
    }

    const raw = await readFile(origin);

    const decoded = decodeRadiance(raw);
    const small = downsample(decoded.data, decoded.width, decoded.height, OUT_W, OUT_H);

    const hdr = encodeRadiance(small, OUT_W, OUT_H);
    await writeFile(join(destination, id + ".hdr"), hdr);

    const thumbFloat = downsample(small, OUT_W, OUT_H, THUMB_W, THUMB_H);
    const png = encodePng(tonemap(thumbFloat), THUMB_W, THUMB_H);
    await writeFile(join(destination, id + ".png"), png);

    index.push(entry(id, name, hdr.length));

    console.log(
      "[hdri] " + name + "  " + decoded.width + "x" + decoded.height + " " + mb(raw.length) +
        "  ->  " + id + ".hdr " + mb(hdr.length) + "  +  " + id + ".png " + kb(png.length),
    );
  }

  await writeFile(join(destination, "index.json"), JSON.stringify(index, null, 2) + "\n");
  console.log("[hdri] " + index.length + " entornos en apps/server/public/hdri");
}

// ---------------------------------------------------------------------------
// Radiance RGBE: lectura
// ---------------------------------------------------------------------------

/**
 * Devuelve { width, height, data } con data en Float32Array RGB lineal.
 *
 * Soporta las tres formas que se encuentran en la practica: pixeles planos,
 * el RLE viejo -un pixel (1,1,1,n) repite el anterior- y el RLE nuevo por
 * scanline, que es el que escriben Blender y Poly Haven.
 */
function decodeRadiance(buffer) {
  let cursor = 0;

  const line = () => {
    const start = cursor;
    while (cursor < buffer.length && buffer[cursor] !== 0x0a) cursor++;
    const text = buffer.toString("latin1", start, cursor);
    cursor++;
    return text;
  };

  const magic = line();
  if (!magic.startsWith("#?")) throw new Error("no parece un archivo Radiance");

  let format = "";
  for (;;) {
    const text = line();
    if (text === "") break;
    if (text.startsWith("FORMAT=")) format = text.slice(7).trim();
    if (cursor >= buffer.length) throw new Error("cabecera sin terminar");
  }
  if (format && format !== "32-bit_rle_rgbe") {
    throw new Error("formato no soportado: " + format);
  }

  const resolution = /^-Y (\d+) \+X (\d+)$/.exec(line().trim());
  if (!resolution) throw new Error("solo se soporta la orientacion -Y +X");
  const height = Number(resolution[1]);
  const width = Number(resolution[2]);

  const data = new Float32Array(width * height * 3);
  const scanline = new Uint8Array(width * 4);

  for (let y = 0; y < height; y++) {
    cursor = readScanline(buffer, cursor, width, scanline);
    for (let x = 0; x < width; x++) {
      const e = scanline[x * 4 + 3];
      const out = (y * width + x) * 3;
      if (e === 0) continue;
      // Referencia de Radiance: la mantisa se escala por 2^(e-128) sobre 256.
      const f = Math.pow(2, e - 136);
      data[out] = scanline[x * 4] * f;
      data[out + 1] = scanline[x * 4 + 1] * f;
      data[out + 2] = scanline[x * 4 + 2] * f;
    }
  }

  return { width, height, data };
}

/** Lee una scanline en `out` y devuelve el cursor ya avanzado. */
function readScanline(buffer, start, width, out) {
  let cursor = start;

  const newRle =
    width >= 8 &&
    width < 32768 &&
    buffer[cursor] === 2 &&
    buffer[cursor + 1] === 2 &&
    ((buffer[cursor + 2] << 8) | buffer[cursor + 3]) === width;

  if (!newRle) {
    // Plano, con el RLE viejo intercalado.
    let x = 0;
    let shift = 0;
    while (x < width) {
      const r = buffer[cursor++];
      const g = buffer[cursor++];
      const b = buffer[cursor++];
      const e = buffer[cursor++];
      if (r === 1 && g === 1 && b === 1) {
        const repeat = e << shift;
        const previous = (x - 1) * 4;
        for (let i = 0; i < repeat && x < width; i++, x++) {
          out[x * 4] = out[previous];
          out[x * 4 + 1] = out[previous + 1];
          out[x * 4 + 2] = out[previous + 2];
          out[x * 4 + 3] = out[previous + 3];
        }
        shift += 8;
      } else {
        out[x * 4] = r;
        out[x * 4 + 1] = g;
        out[x * 4 + 2] = b;
        out[x * 4 + 3] = e;
        x++;
        shift = 0;
      }
    }
    return cursor;
  }

  cursor += 4;
  for (let channel = 0; channel < 4; channel++) {
    let x = 0;
    while (x < width) {
      let count = buffer[cursor++];
      if (count > 128) {
        const value = buffer[cursor++];
        count -= 128;
        for (let i = 0; i < count; i++) out[x++ * 4 + channel] = value;
      } else {
        for (let i = 0; i < count; i++) out[x++ * 4 + channel] = buffer[cursor++];
      }
    }
  }
  return cursor;
}

// ---------------------------------------------------------------------------
// Radiance RGBE: escritura
// ---------------------------------------------------------------------------

function encodeRadiance(data, width, height) {
  const header = Buffer.from(
    "#?RADIANCE\n# Aula EAN Visual - reducida a " + width + "x" + height + "\n" +
      "FORMAT=32-bit_rle_rgbe\n\n-Y " + height + " +X " + width + "\n",
    "latin1",
  );

  const chunks = [header];
  const channels = [
    new Uint8Array(width),
    new Uint8Array(width),
    new Uint8Array(width),
    new Uint8Array(width),
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const rgbe = toRgbe(data[i], data[i + 1], data[i + 2]);
      channels[0][x] = rgbe[0];
      channels[1][x] = rgbe[1];
      channels[2][x] = rgbe[2];
      channels[3][x] = rgbe[3];
    }
    chunks.push(Buffer.from([2, 2, (width >> 8) & 0xff, width & 0xff]));
    for (const channel of channels) chunks.push(rleChannel(channel, width));
  }

  return Buffer.concat(chunks);
}

function toRgbe(r, g, b) {
  const max = Math.max(r, g, b);
  if (!(max > 1e-32)) return [0, 0, 0, 0];
  // frexp: max = mantisa * 2^exponente, con la mantisa en [0.5, 1).
  const exponent = Math.floor(Math.log2(max)) + 1;
  const scale = 256 / Math.pow(2, exponent);
  return [
    clampByte(r * scale),
    clampByte(g * scale),
    clampByte(b * scale),
    clampByte(exponent + 128),
  ];
}

function clampByte(value) {
  const v = Math.floor(value);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** RLE nuevo de un canal: hasta 127 por carrera, hasta 128 por literal. */
function rleChannel(channel, width) {
  const out = [];
  let x = 0;
  while (x < width) {
    let run = 1;
    while (x + run < width && channel[x + run] === channel[x] && run < 127) run++;

    if (run >= 4) {
      out.push(128 + run, channel[x]);
      x += run;
      continue;
    }

    const literals = [];
    while (x < width && literals.length < 128) {
      let ahead = 1;
      while (x + ahead < width && channel[x + ahead] === channel[x] && ahead < 4) ahead++;
      if (ahead >= 4) break;
      literals.push(channel[x]);
      x++;
    }
    out.push(literals.length);
    for (const value of literals) out.push(value);
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// Reduccion y miniatura
// ---------------------------------------------------------------------------

/**
 * Promedio de caja en espacio lineal.
 *
 * En lineal y no sobre los bytes: promediar RGBE ya codificado apaga los
 * brillos, y en un mapa de entorno los brillos son justamente la luz que
 * ilumina la escena.
 */
function downsample(data, width, height, outWidth, outHeight) {
  const accumulator = new Float64Array(outWidth * outHeight * 3);
  const counts = new Uint32Array(outWidth * outHeight);

  for (let y = 0; y < height; y++) {
    const ty = Math.min(outHeight - 1, Math.floor((y * outHeight) / height));
    for (let x = 0; x < width; x++) {
      const tx = Math.min(outWidth - 1, Math.floor((x * outWidth) / width));
      const from = (y * width + x) * 3;
      const to = (ty * outWidth + tx) * 3;
      accumulator[to] += data[from];
      accumulator[to + 1] += data[from + 1];
      accumulator[to + 2] += data[from + 2];
      counts[ty * outWidth + tx]++;
    }
  }

  const out = new Float32Array(outWidth * outHeight * 3);
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i] || 1;
    out[i * 3] = accumulator[i * 3] / n;
    out[i * 3 + 1] = accumulator[i * 3 + 1] / n;
    out[i * 3 + 2] = accumulator[i * 3 + 2] / n;
  }
  return out;
}

/** Reinhard con exposicion automatica, y despues gamma. Solo para la miniatura. */
function tonemap(data) {
  let sum = 0;
  const pixels = data.length / 3;
  for (let i = 0; i < pixels; i++) {
    sum += 0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2];
  }
  const average = sum / pixels;
  const exposure = average > 1e-6 ? Math.min(8, 0.5 / average) : 1;

  const out = Buffer.allocUnsafe(pixels * 3);
  for (let i = 0; i < pixels * 3; i++) {
    const v = data[i] * exposure;
    out[i] = clampByte(Math.pow(v / (1 + v), 1 / 2.2) * 255 + 0.5);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG minimo: RGB de 8 bits, sin filtros
// ---------------------------------------------------------------------------

function encodePng(rgb, width, height) {
  const raw = Buffer.allocUnsafe(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const at = y * (1 + width * 3);
    raw[at] = 0; // filtro "none"
    rgb.copy(raw, at + 1, y * width * 3, (y + 1) * width * 3);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // color verdadero, sin alfa
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

// Perezosa a proposito: el cuerpo del modulo corre antes que las
// declaraciones const que estan mas abajo, y una tabla en una const aqui
// explota con "cannot access before initialization".
let crcTable = null;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------

/** Una entrada del indice que lee el carrusel. */
function entry(id, name, bytes) {
  return {
    id,
    label: humanize(name),
    file: "/hdri/" + id + ".hdr",
    thumb: "/hdri/" + id + ".png",
    width: OUT_W,
    height: OUT_H,
    bytes,
  };
}

/** Cierto si la version reducida es posterior al original y hay miniatura. */
async function isFresh(origin, target) {
  try {
    const [from, to, thumb] = await Promise.all([
      stat(origin),
      stat(target),
      stat(target.replace(/\.hdr$/, ".png")),
    ]);
    return to.mtimeMs >= from.mtimeMs && thumb.size > 0;
  } catch {
    return false;
  }
}

function slug(name) {
  return name
    .replace(/\.hdr$/i, "")
    .replace(/[_-]?\d+k$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function humanize(name) {
  const base = slug(name).replace(/-/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function kb(bytes) {
  return Math.round(bytes / 1024) + " KB";
}

await main();
