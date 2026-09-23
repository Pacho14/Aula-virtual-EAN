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

  private previousGesture: string = "none";
  private raiseSince = 0;
  private handRaised = false;

  get kind() {
    return this.source?.kind ?? "mouse";
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
   * Se llama una vez por cuadro de render. Devuelve el cuadro de entrada y, de
   * paso, emite las acciones que se desprenden de los cambios de gesto.
   */
  tick(now: number): InputFrame {
    if (!this.source) return emptyFrame("mouse");
    const frame = this.source.read();
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
