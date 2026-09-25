/**
 * La tabla de los tres salones, al lado de los portales.
 *
 * Los portales dicen si se puede pasar; la tabla dice qué hay y desde cuándo.
 * Se refresca sola: cuando un profesor abre una clase, su fila se llena, y
 * mientras la clase corre el registro de tiempo va subiendo.
 *
 * No hay horario cargado de antemano a propósito. Un horario escrito a mano
 * que contradiga lo que de verdad está abierto es peor que no tener horario:
 * aquí solo se lee lo que existe.
 */
import { useEffect, useMemo } from "react";
import type { SalonView } from "../net/api";
import { COLOR_ESTADO } from "./Portal";
import { ESTADO_TEXTO } from "../net/api";
import { INK, label, makeSheet, paint, panelBackground, roundedRect, UI_ORDER } from "./surface";

const ANCHO = 1.45;
const ALTO = 1.16;

export function SalonTable({
  salones,
  position,
  rotation,
}: {
  salones: SalonView[];
  position: [number, number, number];
  rotation: [number, number, number];
}) {
  const sheet = useMemo(() => makeSheet(ANCHO, ALTO), []);

  useEffect(() => {
    paint(sheet, (ctx, w, h) => {
      panelBackground(ctx, w, h);

      label(ctx, "CLASES DE HOY", w / 2, 52, {
        size: 32,
        align: "center",
        color: INK.dim,
        weight: 700,
      });

      const izquierda = 42;
      const columnaClase = 190;
      const columnaTiempo = w - 44;

      label(ctx, "SALÓN", izquierda, 112, { size: 24, color: INK.dim, weight: 700 });
      label(ctx, "CLASE", columnaClase, 112, { size: 24, color: INK.dim, weight: 700 });
      label(ctx, "TIEMPO", columnaTiempo, 112, {
        size: 24,
        color: INK.dim,
        align: "right",
        weight: 700,
      });

      let y = 148;
      for (const salon of salones) {
        const color = COLOR_ESTADO[salon.estado];

        roundedRect(ctx, 28, y, w - 56, 136, 16);
        ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
        ctx.fill();

        // Una pestaña de color a la izquierda: enlaza la fila con su portal
        // sin tener que leer el estado dos veces.
        roundedRect(ctx, 28, y, 10, 136, 5);
        ctx.fillStyle = color;
        ctx.fill();

        label(ctx, String(salon.salon), izquierda + 14, y + 52, { size: 44, weight: 700 });
        label(ctx, salon.clase || "Sin clase abierta", columnaClase, y + 46, {
          size: 34,
          color: salon.clase ? INK.text : INK.dim,
        });
        label(ctx, ESTADO_TEXTO[salon.estado], columnaClase, y + 96, {
          size: 26,
          color,
          weight: 700,
        });
        label(ctx, tiempo(salon), columnaTiempo, y + 46, {
          size: 30,
          align: "right",
          color: salon.clase ? INK.text : INK.dim,
        });
        label(ctx, cupo(salon), columnaTiempo, y + 94, {
          size: 24,
          align: "right",
          color: INK.dim,
        });

        y += 150;
      }
    });
  }, [salones, sheet]);

  return (
    <group position={position} rotation={rotation}>
      <mesh raycast={() => null} renderOrder={UI_ORDER.panel}>
        <planeGeometry args={[ANCHO, ALTO]} />
        <meshBasicMaterial
          map={sheet.texture}
          transparent
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/**
 * El registro de tiempo.
 *
 * Antes de empezar se muestra lo que el profesor calculó que va a durar; una
 * vez abierta, cuánto lleva de esa duración. Es lo que alguien que llega tarde
 * necesita saber para decidir si entra.
 */
function tiempo(salon: SalonView) {
  if (!salon.clase) return "—";
  if (salon.transcurridos === null) return `${duracion(salon.minutos)} previstos`;
  return `${duracion(salon.transcurridos)} de ${duracion(salon.minutos)}`;
}

function duracion(total: number) {
  const horas = Math.floor(total / 60);
  const minutos = total % 60;
  if (horas === 0) return `${minutos} min`;
  if (minutos === 0) return `${horas} h`;
  return `${horas} h ${minutos} min`;
}

function cupo(salon: SalonView) {
  if (!salon.clase) return "";
  return `${salon.participantes} de ${salon.capacidad} dentro`;
}
