/**
 * Los controles de cámara, en pantalla y siempre disponibles.
 *
 * La cámara no se desplaza: mira. Y quien la mueve es el deslizador, nunca la
 * mano directamente. La mano agarra el deslizador con un pellizco y lo
 * arrastra, igual que lo haría con el mouse:
 *
 *   puntos de la mano → pellizco → deslizador → giro de la cámara
 *
 * Esa cadena importa. Una cámara pegada a la posición de la mano se mueve
 * cada vez que la mano tiembla y no hay forma de dejarla quieta; un
 * deslizador se queda donde lo sueltas.
 *
 * Están en el DOM y no en la escena 3D a propósito: son controles de la
 * pantalla, no objetos del salón, y tienen que quedarse en su esquina aunque
 * la cámara gire.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { InputLayer } from "../input/inputLayer";
import {
  cameraRig,
  degrees,
  LIMITES,
  rigSnapshot,
  setRigPitch,
  setRigYaw,
  subscribeRig,
} from "../scene/cameraRig";

/** Margen alrededor del riel dentro del cual el pellizco ya cuenta. */
const AGARRE = 26;

interface Riel {
  id: "yaw" | "pitch";
  element: HTMLElement;
  vertical: boolean;
  apply: (t: number) => void;
}

export function CameraControls({
  input,
  handTracking,
  showLandmarks,
  onToggleLandmarks,
}: {
  input: InputLayer;
  /** Con mouse no hay pellizco ni puntos que dibujar. */
  handTracking: boolean;
  showLandmarks: boolean;
  onToggleLandmarks: (value: boolean) => void;
}) {
  useSyncExternalStore(subscribeRig, rigSnapshot);
  const [visible, setVisible] = useState(true);

  const rieles = useRef(new Map<string, Riel>());
  const held = useRef<Riel | null>(null);
  const pinching = useRef(false);
  const cursor = useRef<HTMLDivElement>(null);

  const registrar = useCallback((riel: Riel | null, id: string) => {
    if (riel) rieles.current.set(id, riel);
    else rieles.current.delete(id);
  }, []);

  // --- la mano contra los deslizadores ------------------------------------
  //
  // Bucle propio, fuera de la escena: se lee el último cuadro con `peek` en
  // vez de `tick`, porque avanzar la capa de entrada dos veces por cuadro
  // dispararía cada gesto por duplicado.
  useEffect(() => {
    if (!handTracking) return;
    let handle = 0;

    const pump = () => {
      handle = requestAnimationFrame(pump);
      const hand = input.peek().primary;
      const punto = cursor.current;

      if (!hand) {
        if (punto) punto.style.opacity = "0";
        if (held.current) {
          held.current = null;
          cameraRig.handBusy = false;
        }
        pinching.current = false;
        return;
      }

      const x = (hand.ndcX * 0.5 + 0.5) * window.innerWidth;
      const y = (-hand.ndcY * 0.5 + 0.5) * window.innerHeight;

      if (punto) {
        punto.style.opacity = "1";
        punto.style.transform = `translate(${x - 9}px, ${y - 9}px)`;
        punto.dataset.pinch = hand.gesture === "pinch" ? "si" : "no";
      }

      const ahora = hand.gesture === "pinch";
      if (ahora && !pinching.current) {
        held.current = buscarRiel(rieles.current, x, y);
        cameraRig.handBusy = held.current !== null;
      } else if (!ahora && pinching.current) {
        held.current = null;
        cameraRig.handBusy = false;
      }
      pinching.current = ahora;

      if (held.current) held.current.apply(posicionEnRiel(held.current, x, y));
    };

    handle = requestAnimationFrame(pump);
    return () => {
      cancelAnimationFrame(handle);
      cameraRig.handBusy = false;
    };
  }, [handTracking, input]);

  return (
    <div className="camctl">
      <div className="camctl-head">
        <span>Controles de cámara</span>
        <button type="button" onClick={() => setVisible((v) => !v)}>
          {visible ? "Ocultar" : "Mostrar controles"}
        </button>
      </div>

      {visible && (
        <>
          {handTracking && (
            <label className="camctl-check">
              <input
                type="checkbox"
                checked={showLandmarks}
                onChange={(event) => onToggleLandmarks(event.target.checked)}
              />
              <span>Mostrar puntos de la mano</span>
            </label>
          )}

          <SliderHud
            id="pitch"
            vertical
            label="Vertical"
            limite={LIMITES.pitch}
            valor={cameraRig.pitch}
            onChange={setRigPitch}
            registrar={registrar}
          />
          <SliderHud
            id="yaw"
            label="Horizontal"
            limite={LIMITES.yaw}
            valor={cameraRig.yaw}
            onChange={setRigYaw}
            registrar={registrar}
          />
        </>
      )}

      {handTracking && <div className="camctl-hand" ref={cursor} data-pinch="no" />}
    </div>
  );
}

/**
 * Un deslizador de la pantalla.
 *
 * Hecho a mano y no con `input type=range` porque tiene que aceptar tres
 * cosas: mouse, toque y un pellizco que llega por coordenadas, sin evento de
 * puntero. Con un control propio las tres entran por la misma puerta.
 */
function SliderHud({
  id,
  label,
  limite,
  valor,
  onChange,
  registrar,
  vertical = false,
}: {
  id: "yaw" | "pitch";
  label: string;
  /** El recorrido va de -limite a +limite. */
  limite: number;
  valor: number;
  onChange: (radianes: number) => void;
  registrar: (riel: Riel | null, id: string) => void;
  vertical?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const t = (valor + limite) / (limite * 2);

  const aplicar = useCallback(
    (fraccion: number) => onChange(fraccion * limite * 2 - limite),
    [limite, onChange],
  );

  useEffect(() => {
    const element = track.current;
    if (!element) return;
    registrar({ id, element, vertical, apply: aplicar }, id);
    return () => registrar(null, id);
  }, [aplicar, id, registrar, vertical]);

  const desdeEvento = (event: React.PointerEvent) => {
    const element = track.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const fraccion = vertical
      ? 1 - (event.clientY - rect.top) / rect.height
      : (event.clientX - rect.left) / rect.width;
    aplicar(Math.min(1, Math.max(0, fraccion)));
  };

  return (
    <div className={`camctl-slider ${vertical ? "v" : "h"}`}>
      <span className="camctl-label">
        {label}
        <b>
          {degrees(valor) > 0 ? "+" : ""}
          {degrees(valor)}°
        </b>
      </span>
      <div
        className="camctl-track"
        ref={track}
        role="slider"
        aria-label={`Giro ${label.toLowerCase()} de la cámara`}
        aria-valuemin={-degrees(limite)}
        aria-valuemax={degrees(limite)}
        aria-valuenow={degrees(valor)}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          desdeEvento(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) desdeEvento(event);
        }}
        onKeyDown={(event) => {
          const paso = (5 * Math.PI) / 180;
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") onChange(valor - paso);
          if (event.key === "ArrowRight" || event.key === "ArrowUp") onChange(valor + paso);
        }}
      >
        <div className="camctl-mid" />
        <div
          className="camctl-knob"
          style={vertical ? { bottom: `${t * 100}%` } : { left: `${t * 100}%` }}
        />
      </div>
    </div>
  );
}

function buscarRiel(rieles: Map<string, Riel>, x: number, y: number): Riel | null {
  for (const riel of rieles.values()) {
    const rect = riel.element.getBoundingClientRect();
    if (
      x >= rect.left - AGARRE &&
      x <= rect.right + AGARRE &&
      y >= rect.top - AGARRE &&
      y <= rect.bottom + AGARRE
    ) {
      return riel;
    }
  }
  return null;
}

function posicionEnRiel(riel: Riel, x: number, y: number) {
  const rect = riel.element.getBoundingClientRect();
  const fraccion = riel.vertical
    ? 1 - (y - rect.top) / rect.height
    : (x - rect.left) / rect.width;
  return Math.min(1, Math.max(0, fraccion));
}
