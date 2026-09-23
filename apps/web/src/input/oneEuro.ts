/**
 * Filtro One Euro.
 *
 * Casteljau & Fekete, 2012. A baja velocidad filtra fuerte (el cursor deja de
 * temblar); a alta velocidad casi no filtra (el cursor no se siente pegajoso).
 * Es lo que evita los clics falsos que menciona la seccion 10 del documento.
 */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(
    private minCutoff = 1.2,
    private beta = 0.02,
    private dCutoff = 1.0,
  ) {}

  reset() {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = 0;
  }

  filter(x: number, timestampMs: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = timestampMs;
      return x;
    }

    const dt = Math.max((timestampMs - this.tPrev) / 1000, 1e-4);
    this.tPrev = timestampMs;
    const rate = 1 / dt;

    const dx = (x - this.xPrev) * rate;
    const dxHat = lowpass(dx, this.dxPrev, alpha(rate, this.dCutoff));
    this.dxPrev = dxHat;

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const xHat = lowpass(x, this.xPrev, alpha(rate, cutoff));
    this.xPrev = xHat;
    return xHat;
  }
}

function alpha(rate: number, cutoff: number) {
  const tau = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / rate;
  return 1 / (1 + tau / dt);
}

function lowpass(value: number, previous: number, a: number) {
  return a * value + (1 - a) * previous;
}

/** Tres filtros que comparten parametros, para un punto 2D mas la escala. */
export class HandFilter {
  readonly x = new OneEuroFilter(1.0, 0.035);
  readonly y = new OneEuroFilter(1.0, 0.035);
  // La escala se usa para la profundidad: filtrar mas duro evita que el
  // objeto agarrado se vaya y venga solo.
  readonly span = new OneEuroFilter(0.6, 0.005);

  reset() {
    this.x.reset();
    this.y.reset();
    this.span.reset();
  }
}
