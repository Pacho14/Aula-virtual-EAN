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

/**
 * Los mismos dos neones que la mano en 3D y los rieles, uno por lado.
 *
 * Aquí el color no dice el gesto sino la mano, porque es justo lo que se viene
 * a comprobar: que izquierda y derecha son las que uno cree. La mano derecha
 * va en el color de "estás tomando esto" por ser la que manda el puntero.
 */
const COLOR = {
  left: "#00D9FF",
  right: "#FF2BD6",
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

    /**
     * Lo último que se dibujó, para no repintar lo mismo.
     *
     * El detector va entre 5 y 24 veces por segundo; la pantalla, a 60. Sin
     * esto, este recuadro redibujaba el vídeo y los 21 puntos **sesenta veces
     * por segundo** aunque no hubiera un punto nuevo que enseñar, y lo hacía
     * en el hilo principal: el mismo del que depende que la mano se sienta
     * rápida. Era trabajo puro de depuración compitiendo con lo que depura.
     *
     * Se dibuja cuando hay datos nuevos, y un respaldo cada 250 ms por si el
     * vídeo cambia sin que cambien los puntos.
     */
    let dibujado = -1;
    let dibujadoAt = 0;
    const REPASO_MS = 250;

    const pump = () => {
      handle = requestAnimationFrame(pump);
      const frame = input.peek();

      // `sampledAt` cambia solo cuando el detector entrega una medición nueva,
      // que es lo único que puede cambiar lo que se ve aquí. El repaso cada
      // 250 ms es para el vídeo de fondo, que sí sigue moviéndose aunque no
      // haya manos, y para que el recuadro no se quede congelado al perderlas.
      const ahora = performance.now();
      if (frame.sampledAt === dibujado && ahora - dibujadoAt < REPASO_MS) return;
      dibujado = frame.sampledAt;
      dibujadoAt = ahora;

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

      // Cómo va el detector, arriba y siempre, con manos o sin ellas.
      //
      // Está aquí porque el equilibrio entre fluidez y consumo no se puede
      // ajustar a ciegas. Los cuatro números dicen cosas distintas y hay que
      // leerlos juntos:
      //
      //   - **Hz** es la cadencia a la que se infiere. Si está en 10, el
      //     regulador tocó el piso: este equipo no da para más.
      //   - **ms de costo** es lo que tarda una inferencia. Es la causa; la
      //     cadencia es la consecuencia (ver `CADENCE` en cameraSource.ts).
      //   - **ms de retraso** es lo que pasa desde que la cámara captura el
      //     cuadro hasta que su resultado está dibujable. Es lo que el
      //     adelanto del puntero cancela, y por tanto el número a mirar si la
      //     mano se siente atrasada.
      //   - **manos** baja a 1 cuando ni el piso de cadencia alcanzó.
      //
      // Un `~` delante del retraso avisa de que el navegador no da la marca de
      // captura y se está estimando: ahí el número es un suelo, no la medida.
      const d = input.diagnostics;
      if (d) {
        ctx.fillStyle = "rgba(6, 14, 18, 0.72)";
        ctx.fillRect(0, 0, ancho, 18);
        ctx.fillStyle = "#7FE9FF";
        ctx.font = "500 11px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.textAlign = "left";
        const tilde = d.timedByCamera ? "" : "~";
        ctx.fillText(
          `${d.detectFps}/${d.cadenceHz} Hz · ${d.costMs} ms · ${tilde}${d.latencyMs} ms · ` +
            `${d.delegate ?? "?"} · ${d.numHands} ${d.numHands === 1 ? "mano" : "manos"}`,
          6,
          13,
        );
      }

      const manos = [frame.left, frame.right].filter(Boolean) as HandFrame[];
      if (manos.length === 0) {
        ctx.fillStyle = "#5C7E88";
        ctx.font = "500 13px system-ui, 'Segoe UI', Roboto, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Sin manos a la vista", ancho / 2, alto / 2);
        return;
      }

      for (const mano of manos) {
        const puntos = mano.landmarks;
        if (!puntos || puntos.length < 63) continue;
        const color = COLOR[mano.handedness];

        // El resplandor por `shadowBlur` y no por varias pasadas: es un
        // recuadro de 200x150, así que cuesta nada, y es lo que hace que el
        // esqueleto se lea encima del vídeo sin tener que oscurecerlo más.
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.shadowColor = color;
        ctx.shadowBlur = 6;
        ctx.beginPath();
        for (const [a, b] of HAND_CONNECTIONS) {
          ctx.moveTo(px(puntos[a * 3]!), py(puntos[a * 3 + 1]!));
          ctx.lineTo(px(puntos[b * 3]!), py(puntos[b * 3 + 1]!));
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        ctx.fillStyle = "#F2FBFF";
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
        // La distancia estimada va aquí porque es lo único de la profundidad
        // que no se puede comprobar a ojo: si no se mueve al acercar el brazo,
        // o si sale un número que no se parece a los centímetros que hay de
        // verdad hasta la cámara, el que hay que ajustar es `FOCAL` en
        // input/handSpace.ts. Un cero significa que no se pudo estimar.
        const metros = mano.cameraDistance;
        const etiqueta = mano.handedness === "left" ? "Izquierda" : "Derecha";
        ctx.fillText(
          metros > 0 ? `${etiqueta} · ${metros.toFixed(2)} m` : `${etiqueta} · sin profundidad`,
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
