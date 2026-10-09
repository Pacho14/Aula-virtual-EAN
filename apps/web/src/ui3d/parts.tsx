/**
 * Las piezas sueltas de la interfaz espacial: panel, botón y deslizador.
 *
 * Todo se dibuja con `meshBasicMaterial` y `toneMapped = false`. Lo primero
 * porque un panel no debe recibir la luz de la escena -si el entorno 360 es
 * un atardecer, el menú no puede ponerse naranja-; lo segundo porque al
 * elegir un entorno se enciende el mapeo de tonos, y sin esa bandera el texto
 * perdería contraste justo cuando más se necesita leerlo.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Color, DoubleSide, type Mesh, type MeshBasicMaterial } from "three";
import {
  INK,
  label,
  makeSheet,
  paint,
  panelBackground,
  roundedRect,
  UI_ORDER,
  type Sheet,
} from "./surface";
import { pointer, useWidget } from "./widgets";

/** Un panel: fondo, título y lo que le pongan encima. */
export function Panel({
  width,
  height,
  title,
  children,
}: {
  width: number;
  height: number;
  title?: string;
  children?: React.ReactNode;
}) {
  const sheet = useMemo(() => makeSheet(width, height), [width, height]);

  useEffect(() => {
    paint(sheet, (ctx, w, h) => {
      panelBackground(ctx, w, h);
      if (title) {
        label(ctx, title.toUpperCase(), w / 2, 42, {
          size: 24,
          color: INK.dim,
          align: "center",
          weight: 700,
        });
      }
    });
  }, [sheet, title]);

  return (
    <group>
      <mesh renderOrder={UI_ORDER.panel}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial
          map={sheet.texture}
          transparent
          depthWrite={false}
          toneMapped={false}
          side={DoubleSide}
        />
      </mesh>
      {children}
    </group>
  );
}

/**
 * Un botón que se puede pulsar de dos maneras.
 *
 * La barra que crece en el borde inferior es la espera sostenida: sin ella
 * nadie adivina que basta con dejar la mano quieta, y el botón parece roto
 * hasta que el pellizco sale bien.
 */
export function Button3D({
  id,
  position,
  width,
  height,
  text,
  onActivate,
  disabled = false,
  tone = "normal",
  glyph,
}: {
  id: string;
  position: [number, number, number];
  width: number;
  height: number;
  text: string;
  onActivate: () => void;
  disabled?: boolean;
  tone?: "normal" | "primary";
  /** Dibujo a la izquierda del texto. Dice qué es sin tener que leerlo. */
  glyph?: "sphere" | "cylinder" | "box";
}) {
  const ref = useWidget(id, "button", { activate: onActivate, disabled });
  const backdrop = useRef<Mesh>(null);
  const bar = useRef<Mesh>(null);

  const sheet = useMemo(() => makeSheet(width, height), [width, height]);
  useEffect(() => {
    paint(sheet, (ctx, w, h) => {
      const size = Math.min(30, h * 0.42);
      if (glyph) {
        drawGlyph(ctx, glyph, h * 0.5, h / 2, h * 0.24);
        label(ctx, text, h, h / 2 + 1, { size, color: disabled ? INK.dim : INK.text });
      } else {
        label(ctx, text, w / 2, h / 2 + 1, {
          size,
          color: disabled ? INK.dim : INK.text,
          align: "center",
        });
      }
    });
  }, [sheet, text, disabled, glyph]);

  const plate = useMemo(() => makePlate(width, height), [width, height]);

  const base = useMemo(
    () => new Color(tone === "primary" ? "#0B6E67" : "#25383A"),
    [tone],
  );
  const lit = useMemo(
    () => new Color(tone === "primary" ? "#15A497" : "#3C5A5C"),
    [tone],
  );

  useFrame((_, delta) => {
    const mesh = backdrop.current;
    if (!mesh) return;
    const hovered = pointer.hoveredId === id && !disabled;
    const material = mesh.material as MeshBasicMaterial;
    material.color.lerp(hovered ? lit : base, 1 - Math.exp(-14 * delta));
    material.opacity = disabled ? 0.35 : 1;

    // La barra que se llena mientras corre el contador. Va en el propio botón
    // además del anillo del cursor: el anillo dice *cuánto falta* y la barra
    // dice *de qué control*, que con cuatro botones en fila no es lo mismo.
    const progress = hovered ? pointer.dwell : 0;
    const strip = bar.current;
    if (strip) {
      strip.visible = progress > 0.02;
      strip.scale.x = Math.max(0.001, progress);
      strip.position.x = -width / 2 + (width * progress) / 2;
    }
  });

  return (
    <group position={position}>
      <mesh ref={(mesh) => {
        backdrop.current = mesh;
        ref(mesh);
      }} renderOrder={UI_ORDER.plate}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial
          map={plate}
          transparent
          depthWrite={false}
          toneMapped={false}
          color={base}
        />
      </mesh>
      <mesh position={[0, 0, 0.002]} renderOrder={UI_ORDER.text} raycast={() => null}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={sheet.texture} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh
        ref={bar}
        position={[0, -height / 2 + 0.008, 0.003]}
        renderOrder={UI_ORDER.mark}
        visible={false}
        raycast={() => null}
      >
        <planeGeometry args={[width, 0.008]} />
        <meshBasicMaterial color={INK.accent} transparent depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

/**
 * Un deslizador que se arrastra con la mano cerrada o pellizcada.
 *
 * El blanco del rayo es más alto que el riel dibujado: apuntar a una barra de
 * un centímetro con la mano en el aire es imposible, y agrandar el dibujo
 * solo para poder acertarle deja un panel lleno de barras gordas.
 */
export function Slider3D({
  id,
  position,
  length,
  text,
  value,
  min,
  max,
  format,
  onChange,
}: {
  id: string;
  position: [number, number, number];
  length: number;
  text: string;
  /** Se lee en cada cuadro: el valor vive en el estado de la sala. */
  value: () => number;
  min: number;
  max: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const ref = useWidget(id, "slider", {
    length,
    drag: (t) => onChange(min + t * (max - min)),
  });
  const knob = useRef<Mesh>(null);
  const fill = useRef<Mesh>(null);

  const sheet = useMemo(() => makeSheet(length, 0.09), [length]);
  const shown = useRef("");

  const plate = useMemo(() => makePlate(length, 0.024, 12), [length]);
  const fillPlate = useMemo(() => makePlate(length, 0.024, 12), [length]);

  useFrame(() => {
    const t = (value() - min) / (max - min);
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;

    if (knob.current) {
      knob.current.position.x = (clamped - 0.5) * length;
      const held = pointer.draggingId === id;
      const hovered = pointer.hoveredId === id;
      knob.current.scale.setScalar(held ? 1.35 : hovered ? 1.15 : 1);
    }
    if (fill.current) {
      fill.current.scale.x = Math.max(0.001, clamped);
      fill.current.position.x = -length / 2 + (length * clamped) / 2;
    }

    // Repintar el rótulo cuesta subir la textura a la tarjeta: solo cuando el
    // número que se ve de verdad cambia, no en cada cuadro del arrastre.
    const text2 = format(value());
    if (text2 !== shown.current) {
      shown.current = text2;
      paint(sheet, (ctx, w, h) => {
        label(ctx, text, 6, h / 2, { size: 26, color: INK.dim });
        label(ctx, text2, w - 6, h / 2, { size: 26, color: INK.text, align: "right" });
      });
    }
  });

  return (
    <group position={position}>
      <mesh position={[0, 0.055, 0.001]} renderOrder={UI_ORDER.text} raycast={() => null}>
        <planeGeometry args={[length, 0.09]} />
        <meshBasicMaterial map={sheet.texture} transparent depthWrite={false} toneMapped={false} />
      </mesh>

      {/* Riel dibujado. */}
      <mesh renderOrder={UI_ORDER.plate} raycast={() => null}>
        <planeGeometry args={[length, 0.024]} />
        <meshBasicMaterial
          map={plate}
          transparent
          depthWrite={false}
          toneMapped={false}
          color="#2B4143"
        />
      </mesh>
      <mesh ref={fill} position={[0, 0, 0.001]} renderOrder={UI_ORDER.text} raycast={() => null}>
        <planeGeometry args={[length, 0.024]} />
        <meshBasicMaterial
          map={fillPlate}
          transparent
          depthWrite={false}
          toneMapped={false}
          color={INK.accent}
        />
      </mesh>

      {/* Blanco del rayo: invisible y generoso. */}
      <mesh ref={ref} position={[0, 0, 0.004]} visible={false}>
        <planeGeometry args={[length, 0.11]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      <mesh ref={knob} position={[0, 0, 0.006]} renderOrder={UI_ORDER.mark} raycast={() => null}>
        <circleGeometry args={[0.022, 20]} />
        <meshBasicMaterial color="#F2F6F6" transparent depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

/**
 * Textura de rectángulo redondeado, blanca y con las esquinas transparentes.
 *
 * Se tiñe con el color del material en vez de repintar el canvas: así el
 * mismo dibujo sirve para el botón en reposo, resaltado y apagado, y la
 * transición entre esos estados no cuesta una subida de textura por cuadro.
 */
/** Silueta de la primitiva, en el propio canvas del botón. */
function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: "sphere" | "cylinder" | "box",
  cx: number,
  cy: number,
  r: number,
) {
  ctx.strokeStyle = INK.text;
  ctx.fillStyle = "rgba(242, 246, 246, 0.16)";
  ctx.lineWidth = 3;

  if (glyph === "sphere") {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // El meridiano es lo que la distingue de un círculo cualquiera.
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.42, r, 0, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  if (glyph === "cylinder") {
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.7, cy - r * 0.75);
    ctx.lineTo(cx - r * 0.7, cy + r * 0.75);
    ctx.moveTo(cx + r * 0.7, cy - r * 0.75);
    ctx.lineTo(cx + r * 0.7, cy + r * 0.75);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy - r * 0.75, r * 0.7, r * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy + r * 0.75, r * 0.7, r * 0.26, 0, 0, Math.PI);
    ctx.stroke();
    return;
  }

  const s = r * 0.78;
  const d = r * 0.42;
  ctx.beginPath();
  ctx.rect(cx - s, cy - s + d / 2, s * 2, s * 2 - d / 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - s, cy - s + d / 2);
  ctx.lineTo(cx - s + d, cy - s - d / 2);
  ctx.lineTo(cx + s + d, cy - s - d / 2);
  ctx.lineTo(cx + s, cy - s + d / 2);
  ctx.moveTo(cx + s + d, cy - s - d / 2);
  ctx.lineTo(cx + s + d, cy + s - d);
  ctx.lineTo(cx + s, cy + s);
  ctx.stroke();
}

const plates = new Map<string, ReturnType<typeof makeSheet>["texture"]>();

function makePlate(width: number, height: number, radius = 22) {
  const key = `${width.toFixed(3)}x${height.toFixed(3)}r${radius}`;
  const cached = plates.get(key);
  if (cached) return cached;

  const sheet: Sheet = makeSheet(width, height);
  paint(sheet, (ctx, w, h) => {
    roundedRect(ctx, 1, 1, w - 2, h - 2, radius);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  });
  plates.set(key, sheet.texture);
  return sheet.texture;
}
