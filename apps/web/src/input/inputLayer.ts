/**
 * La capa de entrada propiamente dicha.
 *
 * Toma una fuente (camara, mouse y en la fase 2 WebXR), traduce transiciones
 * de gesto a acciones, y expone un solo cuadro que la escena lee sin provocar
 * renders de React.
 *
 *   MediaPipe  \
 *   WebXR       >--- capa de entrada ---> apuntar / seleccionar / agarrar /
 *   Mouse      /                          soltar / levantar la mano
 */
import { CameraSource, type CameraOptions } from "./cameraSource";
import { MouseSource } from "./mouseSource";
import { emptyFrame, type InputAction, type InputFrame, type InputSource } from "./types";

/** Tiempo que hay que sostener la mano arriba para pedir la palabra. */
const RAISE_HOLD_MS = 1000;
/** Altura en la imagen por encima de la cual se considera "mano arriba". */
const RAISE_HEIGHT = 0.28;

type Listener = (action: InputAction) => void;

export class InputLayer {
  private source: InputSource | null = null;
  private listeners = new Set<Listener>();
  private latest: InputFrame = emptyFrame("mouse");

  private previousGesture: string = "none";
  private raiseSince = 0;
  private handRaised = false;
  /** Si hay una pieza en la mano. Lo escribe la escena en cada cuadro. */
  private carrying = false;

  get kind() {
    return this.source?.kind ?? "mouse";
  }

  /** El <video> de la camara activa, o null si la fuente es mouse/toque. */
  get activeVideo(): HTMLVideoElement | null {
    return this.source instanceof CameraSource ? this.source.videoElement : null;
  }

  /**
   * El ultimo cuadro, sin avanzar nada.
   *
   * `tick` ademas emite acciones, asi que llamarlo dos veces por cuadro
   * dispararia cada gesto por duplicado. Los controles en pantalla, que corren
   * en su propio bucle fuera de la escena, leen por aqui.
   */
  peek(): InputFrame {
    return this.latest;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async useCamera(options: CameraOptions = {}) {
    await this.swap(new CameraSource(options));
  }

  async useMouse() {
    await this.swap(new MouseSource());
  }

  private async swap(next: InputSource) {
    this.source?.stop();
    this.source = next;
    this.previousGesture = "none";
    this.raiseSince = 0;
    await next.start();
  }

  stop() {
    this.source?.stop();
    this.source = null;
  }

  /**
   * Fija el estado de "mano levantada" desde fuera (un boton del HUD).
   *
   * En modo mouse/toque el gesto nunca llega a sostenerse (ver mouseSource,
   * que vuelve a "point" a los 80 ms), asi que este es el unico camino para
   * levantar la mano en ese modo. Tambien reinicia el contador del gesto
   * sostenido para que, en modo camara, una mano que ya estaba arriba no
   * vuelva a emitir el mismo estado en el cuadro siguiente.
   */
  setHandRaised(value: boolean) {
    this.handRaised = value;
    this.raiseSince = 0;
  }

  /**
   * Avisa de si quien usa esto lleva una pieza en la mano.
   *
   * Hace falta porque "pedir la palabra" y "soltar" comparten gesto: los dos
   * son la mano abierta, y lo unico que los separa es la altura. Soltar una
   * pieza en alto es abrir la mano en alto, asi que sin esto pedir la palabra
   * se dispararia solo al dejar algo en la parte de arriba del cuadro.
   */
  setCarrying(value: boolean) {
    this.carrying = value;
  }

  /**
   * Se llama una vez por cuadro de render. Devuelve el cuadro de entrada y, de
   * paso, emite las acciones que se desprenden de los cambios de gesto.
   */
  tick(now: number): InputFrame {
    if (!this.source) {
      this.latest = emptyFrame("mouse");
      return this.latest;
    }
    const frame = this.source.read();
    this.latest = frame;
    const hand = frame.primary;
    const gesture = hand?.gesture ?? "none";

    if (gesture !== this.previousGesture) {
      if (gesture === "pinch") this.emit("select");
      if (gesture === "fist") this.emit("grab");
      // Soltar es cualquier salida del puno, no solo la mano abierta: si el
      // detector pierde la mano a media maniobra, el objeto tiene que caer.
      if (this.previousGesture === "fist") this.emit("release");
      this.previousGesture = gesture;
    }

    // Mano arriba sostenida un segundo = pedir la palabra.
    //
    // Con una pieza en la mano el detector se congela, y se congela en vez de
    // bajar la mano: quien ya pidio la palabra no deberia perderla por
    // recoger un cubo de la mesa.
    if (this.carrying) {
      this.raiseSince = 0;
      return frame;
    }

    const isUp = Boolean(hand) && gesture === "open" && hand!.rawY < RAISE_HEIGHT;
    if (isUp) {
      if (this.raiseSince === 0) this.raiseSince = now;
      else if (!this.handRaised && now - this.raiseSince >= RAISE_HOLD_MS) {
        this.handRaised = true;
        this.emit("raiseHand");
      }
    } else {
      this.raiseSince = 0;
      if (this.handRaised) {
        this.handRaised = false;
        this.emit("lowerHand");
      }
    }

    return frame;
  }

  private emit(action: InputAction) {
    for (const listener of this.listeners) listener(action);
  }
}
