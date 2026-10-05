/**
 * Los 21 puntos de cada mano, dibujados en una esquina.
 *
 * Es una herramienta de calibración, no un adorno: sirve para ver por qué el
 * detector no encuentra una mano -mala luz, contraluz, la mano fuera de
 * cuadro-, y para comprobar que izquierda y derecha son las que uno cree.
 * Por eso se puede apagar.
 *
 * Se dibuja en espejo, como un espejo de verdad: mover la mano a la derecha
 * la mueve a la derecha en pantalla. Sin eso, calibrar con esto desorienta
 * más de lo que ayuda.
 */
import { useEffect, useRef, useState } from "react";
import type { InputLayer } from "../input/inputLayer";
import { HAND_CONNECTIONS, type HandFrame } from "../input/types";

const COMPACTO = { w: 200, h: 150 };
const AMPLIADO = { w: 480, h: 360 };

const COLOR = {
  left: "#12938A",
  right: "#B4531A",
} as const;

export function LandmarkOverlay({
  input,
  expanded = false,
}: {
  input: InputLayer;
  /** Vista ampliada: mas sitio para ver la imagen y el esqueleto completo. */
  expanded?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(COMPACTO);

  useEffect(() => {
    setSize(expanded ? AMPLIADO : COMPACTO);
  }, [expanded]);

  useEffect(() => {
    let handle = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const element = canvas.current;
    if (!element) return;
    const ancho = size.w;
    const alto = size.h;
    element.width = ancho * dpr;
    element.height = alto * dpr;
    const ctx = element.getContext("2d")!;
    // MediaPipe entrega la imagen sin espejo; aqui se ve como en un espejo.
    const px = (x: number) => (1 - x) * ancho;
    const py = (y: number) => y * alto;

    const pump = () => {
      handle = requestAnimationFrame(pump);
      const frame = input.peek();

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, ancho, alto);

      const video = input.activeVideo;
      if (video && video.readyState >= 2) {
        // Estirado a todo el recuadro, sin recortar: MediaPipe recibe el
        // cuadro con el mismo estirado (ver cameraSource.ts, resizeWidth
        // /resizeHeight), asi que los puntos normalizados calzan con esto
        // y no con un recorte centrado, que los desalinearia del video.
        ctx.save();
        ctx.translate(ancho, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, ancho, alto);
        ctx.restore();
        ctx.fillStyle = "rgba(10, 18, 19, 0.28)";
        ctx.fillRect(0, 0, ancho, alto);
      } else {
        ctx.fillStyle = "rgba(10, 18, 19, 0.72)";
        ctx.fillRect(0, 0, ancho, alto);
      }

      const manos = [frame.left, frame.right].filter(Boolean) as HandFrame[];
      if (manos.length === 0) {
        ctx.fillStyle = "#9FB2B0";
        ctx.font = "500 13px system-ui, 'Segoe UI', Roboto, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Sin manos a la vista", ancho / 2, alto / 2);
        return;
      }

      for (const mano of manos) {
        const puntos = mano.landmarks;
        if (!puntos || puntos.length < 63) continue;
        const color = COLOR[mano.handedness];

        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (const [a, b] of HAND_CONNECTIONS) {
          ctx.moveTo(px(puntos[a * 3]!), py(puntos[a * 3 + 1]!));
          ctx.lineTo(px(puntos[b * 3]!), py(puntos[b * 3 + 1]!));
        }
        ctx.stroke();

        ctx.fillStyle = "#F2F6F6";
        for (let i = 0; i < 21; i++) {
          ctx.beginPath();
          // La muñeca y las puntas de los dedos, más grandes: son las que se
          // miran cuando algo no cuadra.
          const grande = i === 0 || i === 4 || i === 8 || i === 12 || i === 16 || i === 20;
          ctx.arc(px(puntos[i * 3]!), py(puntos[i * 3 + 1]!), grande ? 3.2 : 2, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.fillStyle = color;
        ctx.font = "600 12px system-ui, 'Segoe UI', Roboto, sans-serif";
        ctx.textAlign = mano.handedness === "left" ? "left" : "right";
        ctx.fillText(
          mano.handedness === "left" ? "Izquierda" : "Derecha",
          mano.handedness === "left" ? 8 : ancho - 8,
          alto - 8,
        );
      }
    };

    handle = requestAnimationFrame(pump);
    return () => cancelAnimationFrame(handle);
  }, [input, size]);

  return (
    <canvas
      className="landmarks"
      ref={canvas}
      style={{ width: size.w, height: size.h }}
      aria-hidden="true"
    />
  );
}
