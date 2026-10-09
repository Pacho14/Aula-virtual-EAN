/**
 * Cada cuánto se infiere, cuánto se adelanta y cuándo se da una mano por
 * perdida.
 *
 * Aquí no hay DOM, ni MediaPipe, ni three: son números entrando y números
 * saliendo. Está así por el mismo motivo que `handSpace.ts`, y el motivo es
 * el mismo que aprendimos con la quiralidad de la mano: **esto es la clase de
 * cosa que se rompe sin que ninguna prueba de las otras se entere**. Una
 * cadencia mal regulada no da un error; da una mano que va a tirones en un
 * teléfono y perfecta en el portátil de quien la programó. Poder correrlo en
 * un segundo con `npm run test:manos` es la única forma de no descubrirlo en
 * un salón de clase.
 */

/**
 * La cadencia de inferencia y como se regula sola.
 *
 * `duty` es la regla entera. Si una inferencia cuesta `d` ms, correrla `f`
 * veces por segundo gasta `d · f / 1000` de un núcleo. Fijando ese gasto, la
 * cadencia sale de una división: `f = duty · 1000 / d`. En un portátil `d`
 * ronda los 12 ms y la cadencia se va al techo; en un celular de gama media
 * pasa de 40 ms y baja sola, sin medir el modelo del teléfono y sin mantener
 * una tabla de equipos que envejece.
 *
 * El techo no es 30 -lo que da la cámara- porque la mano no se mueve tan
 * rápido: por encima de 24 se gasta batería para refrescar algo que el
 * adelanto ya cubre. El piso es donde el puntero deja de sentirse vivo aunque
 * se adelante; por debajo de él se degrada por otra vía, buscando una sola
 * mano en vez de dos.
 */
export const CADENCE = {
  maxHz: 24,
  minHz: 10,
  /** Con qué se arranca, antes de haber medido una sola inferencia. */
  startHz: 20,
  duty: 0.5,
} as const;

/**
 * A cuántas inferencias por segundo apuntar, dado lo que cuesta una.
 *
 * Devuelve el valor **sin acotar** además del acotado, porque los dos hacen
 * falta y significan cosas distintas: el acotado es la cadencia que se va a
 * usar, y el crudo es el que dice si el equipo cabe en el presupuesto. Un
 * crudo por debajo del piso es la definición de "sobrecargado", y es lo que
 * dispara la degradación a una sola mano. Mirando solo el acotado no hay forma
 * de distinguir "justo en el piso" de "muy por debajo del piso".
 */
export function cadenceFor(costMs: number): { hz: number; wanted: number } {
  // Un costo que no es un número no puede salir de aquí como una cadencia que
  // no es un número, y esto no es celo: un NaN aquí **no da un error, da un
  // detector sin tope ninguno**. El portón de la cadencia pregunta si pasó
  // suficiente tiempo, y cualquier comparación contra NaN sale falsa, así que
  // el portón se queda abierto y se vuelve a inferir al ritmo de la cámara en
  // cualquier equipo -justo lo que esto existe para evitar, y en silencio.
  //
  // Es la misma lección del NaN que ya nos costó un objeto invisible una vez.
  // Sin medición válida se usa la cadencia de arranque, que es lo que se usa
  // antes de haber medido nada.
  if (!Number.isFinite(costMs)) return { hz: CADENCE.startHz, wanted: CADENCE.startHz };

  const wanted = (CADENCE.duty * 1000) / Math.max(costMs, 1);
  return { hz: clamp(wanted, CADENCE.minHz, CADENCE.maxHz), wanted };
}

/**
 * Cuánto hay que creerle a la velocidad al adelantar el puntero, de 0 a 1.
 *
 * El adelanto confía en que la velocidad del último cuadro sigue valiendo.
 * Frenando en seco eso es falso: la velocidad va suavizada, llega tarde al
 * cambio, y el puntero se pasa de largo y vuelve -el rebote que se siente al
 * parar la mano de golpe. Comparar la velocidad nueva contra la anterior dice
 * cuándo está pasando, porque es justo entonces cuando cae.
 *
 * Con la mano acelerando o a velocidad sostenida las dos coinciden, el recorte
 * vale 1 y no se pierde nada de lo que el adelanto da. Es la propiedad que
 * importa: la guardia **no cuesta nada en el caso normal**.
 */
export const BRAKE_FLOOR = 0.25;

export function leadScale(previousSpeed: number, speed: number): number {
  // Sin velocidad anterior no hay frenada que detectar: una mano que acaba de
  // aparecer no puede estar frenando respecto de nada.
  if (!(previousSpeed > 1e-4)) return 1;
  const ratio = speed / previousSpeed;
  return ratio >= 1 ? 1 : Math.max(BRAKE_FLOOR, ratio);
}

/**
 * Cuánto se aguanta sin detecciones antes de apagar el puntero.
 *
 * Atado a la cadencia y no a un número fijo, porque la cadencia ahora se
 * mueve: a 24 Hz dos intervalos y medio son 104 ms y a 10 Hz son 250. Una
 * detección perdida es ruido normal; dos y media es que el detector la perdió
 * de verdad.
 *
 * Lo que esto arregla es una mano que se quedaba **hasta 400 ms congelada en
 * una pose vieja** antes de desaparecer. No derivaba -el adelanto satura- pero
 * sostener una pose que ya no existe es peor que no dibujar nada: quien la ve
 * cree que el detector la sigue, y apunta con una mano que no se está
 * moviendo.
 */
export const LOST_INTERVALS = 2.5;
const LOST_MIN_MS = 120;
const LOST_MAX_MS = 300;

export function lostWindowMs(cadenceHz: number): number {
  return clamp((1000 / cadenceHz) * LOST_INTERVALS, LOST_MIN_MS, LOST_MAX_MS);
}

/**
 * Cuánto se permite adelantar la posición de la mano, en milisegundos.
 *
 * El cuadro que se está dibujando se capturó hace un rato: entre la captura,
 * la detección y el mensaje de vuelta pasan fácil 100 ms, y durante todo ese
 * tiempo el cursor dibuja donde estaba la mano, no donde está. Adelantar por
 * la velocidad que ya calcula el filtro cancela ese retraso en vez de solo
 * reducirlo, y no cuesta nada: con la mano quieta la velocidad es cero.
 *
 * Son 120 y no 90 porque el retraso que se mide ahora es el de verdad -desde
 * la captura del cuadro, no desde que se mandó al worker- y por tanto es
 * mayor. Lo que hace que subirlo sea seguro es `leadScale`: antes el tope era
 * la única protección contra pasarse de largo al frenar, y ahora hay una que
 * mira si la mano está frenando de verdad.
 *
 * Si se nota rebote al parar la mano en seco, el número a bajar es este; si
 * sigue sintiéndose retraso con la mano en movimiento, a subirlo.
 */
export const PREDICT_MS = 120;

/**
 * Cuánto se adelanta de verdad, en segundos, para un cuadro de esta edad.
 *
 * Junta las tres reglas en un solo sitio para que no puedan discrepar: la edad
 * no es negativa -un reloj que entregue algo del futuro haría que el puntero
 * fuera hacia atrás-, no pasa del tope, y se recorta por la frenada.
 */
export function predictSeconds(ageMs: number, lead: number): number {
  const bounded = clamp(ageMs, 0, PREDICT_MS);
  return (bounded / 1000) * lead;
}

/**
 * Acota, y un valor que no es número cae al mínimo en vez de propagarse.
 *
 * Lo segundo importa más que lo primero. `NaN < min` y `NaN > max` son las dos
 * falsas, así que un clamp escrito de la manera obvia devuelve el NaN intacto
 * y queda convencido de haberlo acotado. Todo lo de este archivo alimenta un
 * camino que se recorre en cada cuadro, y el mínimo es siempre el valor
 * prudente: no adelantar nada, o dar la mano por perdida antes.
 */
function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}
