/**
 * Superficies de interfaz dibujadas en un canvas.
 *
 * Los paneles del editor viven dentro de la escena 3D, no en el DOM: tienen
 * que estar donde apunta la mano, y algo en HTML encima del lienzo no recibe
 * el rayo del puntero. Se dibujan en un canvas y se pegan a un plano, que es
 * la misma técnica de los rótulos de nombre de los avatares.
 *
 * Sin tipografías externas, por la misma razón que allá: en una sala de clase
 * con mala conexión, una fuente que no carga deja la interfaz en blanco.
 */
import { CanvasTexture, LinearFilter, SRGBColorSpace } from "three";

/** Píxeles por metro. A 0,9 m de ancho son 576 px: legible sin pesar. */
export const DPI = 640;

export const INK = {
  panel: "rgba(14, 24, 25, 0.88)",
  panelEdge: "rgba(180, 200, 198, 0.35)",
  text: "#F2F6F6",
  dim: "#9FB2B0",
  accent: "#12938A",
  accentSoft: "rgba(18, 147, 138, 0.28)",
  warn: "#B4531A",
} as const;

/**
 * Orden de dibujo dentro de un panel.
 *
 * Todo en la interfaz es transparente y casi coplanar, y three ordena los
 * transparentes por distancia: con dos planos a cuatro milímetros uno de
 * otro, ese orden se decide por redondeo y cambia solo. Cuando salía primero
 * el rótulo, escribía profundidad y el fondo del panel ya no pasaba el test
 * detrás de él: quedaba un rectángulo por el que se veía la sala. Por eso
 * nada de la interfaz escribe profundidad y el orden se fija a mano.
 */
export const UI_ORDER = {
  panel: 10,
  art: 11,
  plate: 12,
  text: 13,
  mark: 14,
} as const;

export interface Sheet {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
  /** Tamaño en píxeles del canvas. */
  w: number;
  h: number;
}

export function makeSheet(widthM: number, heightM: number): Sheet {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(widthM * DPI);
  canvas.height = Math.round(heightM * DPI);
  const ctx = canvas.getContext("2d")!;
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.colorSpace = SRGBColorSpace;
  return { canvas, ctx, texture, w: canvas.width, h: canvas.height };
}

/** Repinta la hoja y avisa a three de que la textura cambió. */
export function paint(sheet: Sheet, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
  sheet.ctx.clearRect(0, 0, sheet.w, sheet.h);
  draw(sheet.ctx, sheet.w, sheet.h);
  sheet.texture.needsUpdate = true;
}

export function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** El fondo de un panel: rectángulo redondeado con borde tenue. */
export function panelBackground(ctx: CanvasRenderingContext2D, w: number, h: number) {
  roundedRect(ctx, 4, 4, w - 8, h - 8, 26);
  ctx.fillStyle = INK.panel;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = INK.panelEdge;
  ctx.stroke();
}

export function font(size: number, weight = 600) {
  return `${weight} ${size}px system-ui, 'Segoe UI', Roboto, sans-serif`;
}

export function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: { size?: number; color?: string; align?: CanvasTextAlign; weight?: number } = {},
) {
  ctx.font = font(options.size ?? 28, options.weight ?? 600);
  ctx.fillStyle = options.color ?? INK.text;
  ctx.textAlign = options.align ?? "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}
