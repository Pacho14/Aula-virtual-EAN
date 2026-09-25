/**
 * El teclado del código, dentro de la escena.
 *
 * Tocar un portal no abre nada: hay que escribir el código que repartió el
 * profesor. Y hay que poder escribirlo con la mano, sin teclado, porque quien
 * está en el lobby puede tener el teléfono en un soporte y las dos manos en el
 * aire. De ahí un teclado numérico de verdad y no un campo de texto.
 */
import { useEffect, useMemo } from "react";
import { ESTADO_TEXTO, type SalonView } from "../net/api";
import { Button3D, Panel } from "./parts";
import { INK, label, makeSheet, paint, roundedRect, UI_ORDER } from "./surface";

const ANCHO = 0.98;
const ALTO = 1.16;
const DIGITOS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

export function Keypad({
  vista,
  codigo,
  error,
  busy,
  position,
  rotation,
  onDigit,
  onBackspace,
  onSubmit,
  onCancel,
}: {
  vista: SalonView;
  codigo: string;
  error: string | null;
  busy: boolean;
  position: [number, number, number];
  rotation: [number, number, number];
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const pantalla = useMemo(() => makeSheet(0.78, 0.3), []);

  useEffect(() => {
    paint(pantalla, (ctx, w, h) => {
      label(ctx, vista.clase || `Salón ${vista.salon}`, w / 2, 26, {
        size: 24,
        align: "center",
        color: INK.dim,
      });

      roundedRect(ctx, 10, 48, w - 20, 74, 14);
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = error ? INK.warn : INK.accent;
      ctx.stroke();

      // Seis casillas y no un texto suelto: se ve cuántos dígitos faltan sin
      // tener que contarlos.
      const casilla = (w - 60) / 6;
      for (let i = 0; i < 6; i++) {
        const cx = 30 + casilla * (i + 0.5);
        const digito = codigo[i];
        label(ctx, digito ?? "·", cx, 86, {
          size: digito ? 44 : 34,
          align: "center",
          color: digito ? INK.text : "rgba(159, 178, 176, 0.5)",
          weight: 700,
        });
      }

      label(ctx, error ?? ESTADO_TEXTO[vista.estado], w / 2, 152, {
        size: 21,
        align: "center",
        color: error ? INK.warn : INK.dim,
        weight: error ? 700 : 600,
      });
    });
  }, [codigo, error, pantalla, vista.clase, vista.estado, vista.salon]);

  return (
    <group position={position} rotation={rotation}>
      <Panel width={ANCHO} height={ALTO} title="Código de la sala">
        <mesh position={[0, 0.34, 0.004]} renderOrder={UI_ORDER.text} raycast={() => null}>
          <planeGeometry args={[0.78, 0.3]} />
          <meshBasicMaterial
            map={pantalla.texture}
            transparent
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>

        {DIGITOS.map((digito, i) => {
          // Tres columnas, y el cero al final centrado bajo el ocho.
          const fila = Math.floor(i / 3);
          const columna = i % 3;
          const x = i === 9 ? 0 : (columna - 1) * 0.23;
          const y = 0.12 - fila * 0.155;
          return (
            <Button3D
              key={digito}
              id={`tecla-${digito}`}
              position={[x, y, 0.004]}
              width={0.2}
              height={0.13}
              text={digito}
              disabled={busy || codigo.length >= 6}
              onActivate={() => onDigit(digito)}
            />
          );
        })}

        <Button3D
          id="tecla-borrar"
          position={[-0.23, -0.3475, 0.004]}
          width={0.2}
          height={0.13}
          text="Borrar"
          disabled={busy || codigo.length === 0}
          onActivate={onBackspace}
        />
        <Button3D
          id="tecla-entrar"
          position={[0.23, -0.3475, 0.004]}
          width={0.2}
          height={0.13}
          tone="primary"
          text={busy ? "..." : "Entrar"}
          disabled={busy || codigo.length !== 6}
          onActivate={onSubmit}
        />
        <Button3D
          id="tecla-cancelar"
          position={[0, -0.5, 0.004]}
          width={0.5}
          height={0.11}
          text="Volver al lobby"
          disabled={busy}
          onActivate={onCancel}
        />
      </Panel>
    </group>
  );
}
