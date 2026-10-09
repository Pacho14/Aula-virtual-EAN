/**
 * Los controles de cámara, en pantalla y siempre disponibles.
 *
 * La cámara no se desplaza: mira. Y quien la mueve es el deslizador, nunca la
 * mano directamente. Esa cadena importa: una cámara pegada a la posición de la
 * mano se mueve cada vez que la mano tiembla y no hay forma de dejarla quieta;
 * un deslizador se queda donde lo sueltas.
 *
 * ## Cómo se maneja un riel con la mano
 *
 *   punta del índice → engancharse → centro de la palma → giro de la cámara
 *
 * Los dos puntos de la mano hacen cosas distintas, y a propósito:
 *
 * - **Se apunta con la punta del índice**, que es lo que la gente usa para
 *   señalar y lo que ya señala en la escena y en el lobby.
 * - **Se arrastra con el centro de la palma**, que es lo que no tiembla. Una
 *   punta de dedo se dobla, se desplaza al cerrar la mano y tiene su propio
 *   temblor; la palma es el punto más estable de los veintiuno, y arrastrar es
 *   justo donde eso se nota.
 *
 * Y el arrastre es **relativo**: al engancharse se recuerda dónde estaba el
 * mando y dónde la palma, y de ahí en adelante el mando se mueve lo que se
 * mueva la palma. Absoluto no sirve aquí: estos rieles son dos barras de
 * dieciséis píxeles en una esquina, así que un mapeo directo metería los 180°
 * de giro en el ancho de la barra y pediría quedarse dentro de ella con una
 * mano que tiembla. Relativo desacopla el recorrido de la mano del tamaño del
 * riel, y además no da el salto que daba el mando al aparecer donde se
 * apuntaba.
 *
 * Están en el DOM y no en la escena 3D a propósito: son controles de la
 * pantalla, no objetos del salón, y tienen que quedarse en su esquina aunque
 * la cámara gire.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { HandFrame } from "../input/types";
import { HOLD_GESTURES } from "../input/types";
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
import { DWELL_MS } from "../ui3d/pointer";

/** Margen alrededor del riel dentro del cual apuntar ya cuenta. */
const AGARRE = 26;

/**
 * Cuánto tiene que recorrer la palma, en coordenadas normalizadas, para
 * llevar un riel de un extremo al otro.
 *
 * Las coordenadas que llegan ya traen la ganancia del puntero (`GAIN` en
 * cameraSource.ts), así que 1,2 de aquí es aproximadamente un tercio del
 * campo de visión de la webcam: un barrido cómodo del antebrazo, sin estirar
 * el codo hasta el borde del cuadro.
 *
 * Es el número a mover si el riel se siente pesado -bajarlo- o nervioso
 * -subirlo.
 */
const RECORRIDO = 1.2;

/**
 * Cuánto se puede ir la palma en perpendicular al riel antes de soltarlo.
 *
 * Hace falta porque un riel enganchado por espera no se suelta al dejar de
 * apuntarlo -no hay gesto que soltar-, así que sin una salida se quedaría
 * prendido de la mano. Se mide perpendicular y no a lo largo: recorrer el riel
 * de punta a punta es el uso normal y pasarse del extremo no puede soltarlo.
 *
 * Generoso a propósito: es una vía de escape, no una zona de precisión. Quien
 * quiera soltar deliberadamente cierra la mano, que es inmediato.
 */
const ESCAPE_NDC = 0.85;

interface Riel {
  id: "yaw" | "pitch";
  element: HTMLElement;
  vertical: boolean;
  apply: (t: number) => void;
  /** Dónde está el mando ahora, de 0 a 1. Lo necesita el arrastre relativo. */
  value: () => number;
}

/** Lo que hay que recordar del instante en que un riel se engancha. */
interface Enganche {
  riel: Riel;
  /** Valor del riel al engancharlo. El arrastre se mide desde aquí. */
  t0: number;
  /** Dónde estaba la palma entonces, a lo largo del riel. */
  anchor: number;
  /** Y en perpendicular, para la vía de escape. */
  cross: number;
}

export function CameraControls({
  input,
  handTracking,
  showLandmarks,
  onToggleLandmarks,
  landmarksExpanded,
  onToggleExpanded,
}: {
  input: InputLayer;
  /** Con mouse no hay gestos ni puntos que dibujar. */
  handTracking: boolean;
  showLandmarks: boolean;
  onToggleLandmarks: (value: boolean) => void;
  landmarksExpanded: boolean;
  onToggleExpanded: (value: boolean) => void;
}) {
  useSyncExternalStore(subscribeRig, rigSnapshot);
  const [visible, setVisible] = useState(true);

  const rieles = useRef(new Map<string, Riel>());
  const enganchado = useRef<Enganche | null>(null);
  /** Para enganchar en el flanco y no en el estado: ver `press` en el bucle. */
  const cerrada = useRef(false);
  /**
   * La mano acaba de soltar un riel y sigue cerrada.
   *
   * Mientras dure, la escena no escucha. Sin esto, el mismo cierre con el que
   * se suelta el riel seguiría vivo un cuadro después y la escena lo leería
   * como un gesto nuevo: soltar el deslizador pulsaría el botón que hubiera
   * detrás. Se levanta en cuanto la mano se abre.
   */
  const bloqueo = useRef(false);
  /** Qué riel se está esperando y desde cuándo. El contador. */
  const espera = useRef<{ riel: Riel | null; desde: number }>({ riel: null, desde: 0 });
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

    const soltar = () => {
      enganchado.current = null;
      espera.current.riel = null;
    };

    const enganchar = (riel: Riel, hand: HandFrame) => {
      enganchado.current = {
        riel,
        t0: riel.value(),
        anchor: riel.vertical ? hand.ndcY : hand.ndcX,
        cross: riel.vertical ? hand.ndcX : hand.ndcY,
      };
      // El contador ya cumplió: se reinicia para que al soltar este riel no
      // quede medio lleno de la vez anterior.
      espera.current.riel = null;
    };

    /**
     * Enciende el riel apuntado y el enganchado, y apaga el resto.
     *
     * Se hace sobre el riel concreto y desde aquí -no con un selector de CSS
     * que mire al punto de la mano- porque con dos rieles a la vez el estado
     * es de cada uno, no de la pantalla: enganchar el horizontal no puede
     * encender el vertical. Son dos elementos, así que recorrerlos en cada
     * cuadro no cuesta nada.
     */
    const marcar = (apuntado: Riel | null, tomado: Riel | null, avance = 0) => {
      for (const riel of rieles.current.values()) {
        const { dataset } = riel.element;
        if (riel === tomado) dataset.enganchado = "si";
        else delete dataset.enganchado;
        if (riel === apuntado && riel !== tomado) dataset.apuntado = "si";
        else delete dataset.apuntado;
        // El contador solo corre en el riel apuntado; el otro queda a cero.
        riel.element.style.setProperty("--avance", riel === apuntado ? String(avance) : "0");
      }
    };

    /** Deja el punto encima del mando de un riel, a la fracción que diga. */
    const puntoEnElRiel = (punto: HTMLDivElement, riel: Riel, t: number) => {
      const rect = riel.element.getBoundingClientRect();
      const x = riel.vertical ? rect.left + rect.width / 2 : rect.left + t * rect.width;
      const y = riel.vertical ? rect.bottom - t * rect.height : rect.top + rect.height / 2;
      punto.style.transform = `translate(${x - 9}px, ${y - 9}px)`;
    };

    /**
     * Si la escena debe ignorar la mano.
     *
     * Se decide **aquí y solo aquí**, al final de cada vuelta y a partir del
     * estado, en vez de que lo escriba quien engancha y quien suelta. Con dos
     * sitios tocándolo, soltar un riel lo apagaba en el mismo cuadro en que
     * `bloqueo` lo quería encendido, y cuál ganaba dependía del orden en que
     * corrieran los bucles.
     */
    const paso = () => {
      const hand = input.peek().primary;
      const punto = cursor.current;
      const now = performance.now();

      if (!hand) {
        if (punto) punto.style.opacity = "0";
        if (enganchado.current) soltar();
        cerrada.current = false;
        bloqueo.current = false;
        espera.current.riel = null;
        marcar(null, null);
        return;
      }

      // Cerrar la mano -puño o pellizco- es lo que engancha y lo que suelta.
      // Se mira el flanco y no el estado: con la mano ya cerrada, pasarla por
      // delante de los rieles camino de otra cosa los engancharía de paso.
      const cerrando = HOLD_GESTURES.has(hand.gesture);
      const press = cerrando && !cerrada.current;
      cerrada.current = cerrando;

      // Mientras la mano siga cerrada después de soltar, no cuenta nada.
      if (bloqueo.current && !cerrando) bloqueo.current = false;

      // **Un riel enganchado se queda enganchado aunque abras la mano.**
      //
      // Esta es la diferencia con todo lo demás, y es deliberada: un riel no
      // se *lleva*, se *ajusta*. Sostener la mano cerrada durante todo un
      // recorrido cansa el brazo y, peor, es justo lo que peor lee el detector
      // -un pellizco que se mantiene medio segundo se pierde un cuadro y el
      // riel se soltaba solo a mitad de camino.
      //
      // Enganchado, el riel sigue el centro de la palma sin pedir nada. Se
      // suelta **volviendo a cerrar la mano** o saliéndote de su eje. Las dos
      // son deliberadas, que es lo que hace falta aquí: una pieza se te puede
      // caer, un ajuste de cámara no debería deshacerse solo.
      //
      // No vuelve a probar contra nada mientras está enganchado: pasar por
      // encima del otro riel mientras se ajusta este no lo roba.
      const actual = enganchado.current;
      if (actual) {
        const along = actual.riel.vertical ? hand.ndcY : hand.ndcX;
        const cross = actual.riel.vertical ? hand.ndcX : hand.ndcY;
        if (press || Math.abs(cross - actual.cross) > ESCAPE_NDC) {
          // Soltar cerrando la mano deja el cierre "gastado": ver `bloqueo`.
          bloqueo.current = press;
          soltar();
          marcar(null, null);
          if (punto) punto.style.opacity = "0";
          return;
        } else {
          const t = clamp01(actual.t0 + (along - actual.anchor) / RECORRIDO);
          actual.riel.apply(t);
          marcar(null, actual.riel);
          if (punto) {
            punto.style.opacity = "1";
            punto.dataset.estado = "enganchado";
            puntoEnElRiel(punto, actual.riel, t);
          }
          return;
        }
      }

      // Se apunta con la punta del índice, igual que en la escena y en el
      // lobby. El arrastre es lo único que va por la palma.
      const x = (hand.indexNdcX * 0.5 + 0.5) * window.innerWidth;
      const y = (-hand.indexNdcY * 0.5 + 0.5) * window.innerHeight;
      const sobre = buscarRiel(rieles.current, x, y);

      // **El contador, igual que en los botones del salón.**
      //
      // Estos rieles se quedaron sin él, y es el peor sitio donde podía
      // faltar: son los controles que están en pantalla **todo el rato**, en
      // todas las pantallas, y son lo primero que alguien intenta usar. Sin
      // contador, la única forma de moverlos era cerrar la mano, que es justo
      // el gesto que peor lee el detector. Apuntabas al riel y no pasaba nada.
      //
      // Al completarse **engancha**, que es lo que un riel hace. Cerrar la
      // mano hace lo mismo pero ya, igual que en el resto de la interfaz.
      let avance = 0;
      if (sobre && !bloqueo.current) {
        if (press) {
          enganchar(sobre, hand);
        } else {
          if (espera.current.riel !== sobre) {
            espera.current.riel = sobre;
            espera.current.desde = now;
          }
          avance = Math.min(1, (now - espera.current.desde) / DWELL_MS);
          if (avance >= 1) {
            enganchar(sobre, hand);
            avance = 0;
          }
        }
      } else {
        espera.current.riel = null;
      }

      marcar(sobre, enganchado.current?.riel ?? null, avance);

      if (punto) {
        // El punto solo se ve cuando sirve de algo: encima de un riel o
        // manejándolo. Suelto por la pantalla era un cursor permanente que no
        // apuntaba a nada, y además lleva la ganancia del puntero, así que se
        // iba a la esquina mientras la mano estaba centrada.
        const activo = Boolean(enganchado.current) || Boolean(sobre);
        punto.style.opacity = activo ? "1" : "0";
        punto.dataset.estado = enganchado.current ? "enganchado" : sobre ? "sobre" : "suelto";
        // El arco del contador, que el CSS dibuja desde esta variable.
        punto.style.setProperty("--dwell", `${Math.round(avance * 360)}deg`);
        if (!enganchado.current) punto.style.transform = `translate(${x - 9}px, ${y - 9}px)`;
      }
    };

    const pump = () => {
      handle = requestAnimationFrame(pump);
      paso();
      cameraRig.handBusy = Boolean(enganchado.current) || bloqueo.current;
    };

    handle = requestAnimationFrame(pump);
    return () => {
      cancelAnimationFrame(handle);
      // Los rieles sobreviven a este efecto -se vuelve a montar al cambiar de
      // modo de entrada-, así que hay que apagarlos: un riel que se quedara
      // encendido diría que la mano lo tiene cuando ya no hay mano.
      marcar(null, null);
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

          {handTracking && showLandmarks && (
            <label className="camctl-check">
              <input
                type="checkbox"
                checked={landmarksExpanded}
                onChange={(event) => onToggleExpanded(event.target.checked)}
              />
              <span>Ampliar vista de depuración</span>
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

      {handTracking && <div className="camctl-hand" ref={cursor} data-estado="suelto" />}
    </div>
  );
}

/**
 * Un deslizador de la pantalla.
 *
 * Hecho a mano y no con `input type=range` porque tiene que aceptar cuatro
 * cosas: mouse, toque, teclado y una mano que llega por coordenadas, sin
 * evento de puntero. Con un control propio las cuatro entran por la misma
 * puerta.
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

  /**
   * El valor de ahora mismo, leíble desde el bucle de la mano.
   *
   * Va por referencia y no por closure porque el riel se registra una vez y el
   * valor cambia en cada render: una closure capturaría el de aquel momento, y
   * el arrastre relativo partiría siempre del valor que tenía el riel cuando
   * se montó. Es el mismo error que `useWidget` evita en la interfaz 3D.
   */
  const actual = useRef(t);
  actual.current = t;

  const aplicar = useCallback(
    (fraccion: number) => onChange(fraccion * limite * 2 - limite),
    [limite, onChange],
  );

  useEffect(() => {
    const element = track.current;
    if (!element) return;
    registrar({ id, element, vertical, apply: aplicar, value: () => actual.current }, id);
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
        {/*
          El contador, dibujado **sobre el propio riel**.

          El arco alrededor del puntito también lo marca, pero el puntito mide
          dieciocho píxeles y está en una esquina de la pantalla: se pierde. Lo
          que hace que se entienda es que se llene el control al que apuntas,
          igual que la barra que recorre los botones del salón. El avance lo
          escribe el bucle de la mano en `--avance`, de 0 a 1.
        */}
        <div className="camctl-dwell" />
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

function clamp01(value: number) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
