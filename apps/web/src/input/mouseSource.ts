/**
 * Respaldo por mouse o toque.
 *
 * El documento lo pide como modo de respaldo permanente, no como accesibilidad
 * ocasional: sirve cuando la luz esta mala, cuando el brazo se cansa, y para
 * que un profesor pueda preparar la clase sin encender la camara.
 *
 * Escucha en window y no en el lienzo a proposito. La entrada se inicia
 * mientras todavia esta en pantalla el formulario, asi que el div de la sala
 * aun no existe; engancharse a el fallaba justo al entrar. Como el lienzo
 * ocupa toda la ventana, medir contra la ventana da el mismo resultado.
 */
import { emptyFrame, type Gesture, type InputFrame, type InputSource } from "./types";

export class MouseSource implements InputSource {
  readonly kind = "mouse" as const;

  private frame: InputFrame = emptyFrame("mouse");
  private ndcX = 0;
  private ndcY = 0;
  private gesture: Gesture = "point";

  async start() {
    window.addEventListener("pointermove", this.onMove, { passive: true });
    window.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointercancel", this.onUp);
    this.update();
  }

  stop() {
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointercancel", this.onUp);
    this.frame = emptyFrame("mouse");
  }

  read(): InputFrame {
    return this.frame;
  }

  private onMove = (event: PointerEvent) => {
    this.ndcX = (event.clientX / window.innerWidth) * 2 - 1;
    this.ndcY = -((event.clientY / window.innerHeight) * 2 - 1);
    this.update();
  };

  // Mantener presionado equivale al puno: agarrar y mover.
  private onDown = (event: PointerEvent) => {
    // Pulsar el boton del microfono no deberia agarrar la valvula que quedo
    // detras del HUD.
    if (isInterface(event.target)) return;
    // Con mouse esto no hacia falta: el mouse siempre manda pointermove antes
    // de cualquier click, asi que ndcX/ndcY ya estaban al dia. Con toque no
    // hay hover: el primer evento de un toque puede ser este pointerdown sin
    // un pointermove previo en esa posicion, y sin esto el rayo apuntaba a
    // donde estuvo el toque anterior, no al que acaba de ocurrir.
    this.ndcX = (event.clientX / window.innerWidth) * 2 - 1;
    this.ndcY = -((event.clientY / window.innerHeight) * 2 - 1);
    this.gesture = "fist";
    this.update();
  };

  private onUp = () => {
    if (this.gesture !== "fist") return;
    this.gesture = "open";
    this.update();
    // Tras soltar vuelve a apuntar, o quedaria emitiendo "soltar" para siempre.
    setTimeout(() => {
      if (this.gesture === "open") {
        this.gesture = "point";
        this.update();
      }
    }, 80);
  };

  private update() {
    const hand = {
      handedness: "right" as const,
      ndcX: this.ndcX,
      ndcY: this.ndcY,
      // El mouse no tiene dedos: el puntero del lobby es el mismo.
      indexNdcX: this.ndcX,
      indexNdcY: this.ndcY,
      rawY: (1 - this.ndcY) / 2,
      span: 0.1,
      gesture: this.gesture,
      pinch: this.gesture === "fist" ? 1 : 0,
      // El mouse no tiene dedos. Nada que dibujar en la vista de puntos.
      landmarks: null,
      worldLandmarks: null,
    };
    this.frame = { source: "mouse", left: null, right: hand, primary: hand, detectFps: 0 };
  }
}

function isInterface(target: EventTarget | null) {
  // Arrastrar el deslizador de la camara no puede, ademas, agarrar la pieza
  // que quedo detras.
  return (
    target instanceof Element &&
    target.closest("button, input, label, .hud-top, .hud-bottom, .camctl")
  );
}
