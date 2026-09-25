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
import { useEffect, useRef } from "react";
import type { InputLayer } from "../input/inputLayer";
import { HAND_CONNECTIONS, type HandFrame } from "../input/types";

const ANCHO = 200;
const ALTO = 150;

const COLOR = {
  left: "#12938A",
  right: "#B4531A",
} as const;

export function LandmarkOverlay({ input }: { input: InputLayer }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let handle = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const element = canvas.current;
    if (!element) return;
    element.width = ANCHO * dpr;
    element.height = ALTO * dpr;
    const ctx = element.getContext("2d")!;

    const pump = () => {
      handle = requestAnimationFrame(pump);
      const frame = input.peek();

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, ANCHO, ALTO);
      ctx.fillStyle = "rgba(10, 18, 19, 0.72)";
      ctx.fillRect(0, 0, ANCHO, ALTO);

      const manos = [frame.left, frame.right].filter(Boolean) as HandFrame[];
      if (manos.length === 0) {
        ctx.fillStyle = "#9FB2B0";
        ctx.font = "500 13px system-ui, 'Segoe UI', Roboto, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Sin manos a la vista", ANCHO / 2, ALTO / 2);
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
          mano.handedness === "left" ? 8 : ANCHO - 8,
          ALTO - 8,
        );
      }
    };

    handle = requestAnimationFrame(pump);
    return () => cancelAnimationFrame(handle);
  }, [input]);

  return <canvas className="landmarks" ref={canvas} aria-hidden="true" />;
}

/** MediaPipe entrega la imagen sin espejo; aquí se ve como en un espejo. */
function px(x: number) {
  return (1 - x) * ANCHO;
}

function py(y: number) {
  return y * ALTO;
}
