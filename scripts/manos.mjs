/**
 * Prueba de la conversion de coordenadas de la mano.
 *
 *   node --import tsx scripts/manos.mjs
 *
 * No abre navegador ni enciende la camara: `handSpace.ts` son numeros
 * entrando y numeros saliendo, a proposito. Y hace falta probarlo asi porque
 * el error que tenia no se ve en ninguna prueba de posicion: la mano salia en
 * su sitio, del tamaño correcto y moviendose en la direccion correcta. Lo
 * unico que estaba mal era su quiralidad -la mano derecha dibujada con la
 * forma de una izquierda-, y eso solo se detecta mirando el determinante o
 * construyendo una mano de la que ya se sabe la respuesta.
 *
 * La mano sintetica de aqui abajo es una mano DERECHA en coordenadas de
 * MediaPipe, con la palma apuntando a un sitio que conocemos. Si la
 * conversion es un giro, la palma sigue apuntando al mismo sitio girado. Si
 * es una reflexion, la normal de los nudillos se da la vuelta y la prueba
 * falla.
 */
import assert from "node:assert/strict";
import {
  JOINT_COUNT,
  REACH,
  VIEW_DETERMINANT,
  INDEX_TIP,
  estimateCameraDistance,
  jointInViewSpace,
  knuckleNormal,
  palmInViewSpace,
  toViewSpace,
  vectorToViewSpace,
  viewDepth,
} from "../apps/web/src/input/handSpace.ts";
import {
  BRAKE_FLOOR,
  CADENCE,
  PREDICT_MS,
  cadenceFor,
  leadScale,
  lostWindowMs,
  predictSeconds,
} from "../apps/web/src/input/cadence.ts";
import { opensHand } from "../apps/web/src/input/types.ts";
import { GestureStabilizer } from "../apps/web/src/input/gestures.ts";
import { DWELL_MS, WidgetPointer } from "../apps/web/src/ui3d/pointer.ts";
import { pointer, widgets } from "../apps/web/src/ui3d/widgets.ts";

const WRIST = 0;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;

let hechas = 0;
const fallos = [];
/**
 * No se corta en el primer fallo a proposito.
 *
 * Un solo signo mal puesto rompe varias de estas pruebas a la vez, y la
 * primera que salta no es la que mejor explica que pasa: conviene ver todas
 * las que cayeron.
 */
function prueba(nombre, fn) {
  hechas += 1;
  try {
    fn();
    console.log(`  ok    ${nombre}`);
  } catch (error) {
    fallos.push({ nombre, mensaje: error.message });
    console.log(`  FALLA ${nombre}`);
  }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const escalar = (v, k) => [v[0] * k, v[1] * k, v[2] * k];
const suma = (...vs) => vs.reduce((a, v) => [a[0] + v[0], a[1] + v[1], a[2] + v[2]], [0, 0, 0]);
const cruz = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalizar = (v) => escalar(v, 1 / Math.hypot(v[0], v[1], v[2]));

/**
 * Una mano derecha sintetica, en los ejes de MediaPipe: X a la derecha de la
 * imagen, Y hacia abajo, Z alejandose de la camara.
 *
 * Se construye desde un marco anatomico explicito para que la respuesta no
 * dependa de como se numeren los ejes:
 *
 *   `across`  del nudillo del indice al del meñique -o sea, hacia el meñique.
 *   `along`   de la muñeca a los nudillos, hacia las puntas.
 *
 * Para una mano derecha, y en cualquier sistema de mano derecha,
 * (indice − muñeca) × (meñique − muñeca) apunta hacia la palma. Asi que la
 * direccion de la palma no se escribe a mano -eso ya se escribio mal una vez-
 * sino que sale de `along × across`, y se devuelve junto con los puntos. La
 * prueba la comprueba igual antes de convertir nada: si el constructor se
 * rompe, la prueba deja de probar algo.
 */
function manoDerecha({ along, across, distanciaDedos = 0.17 }) {
  const palm = normalizar(cruz(along, across));
  const puntos = new Float32Array(JOINT_COUNT * 3);
  const poner = (i, v) => {
    puntos[i * 3] = v[0];
    puntos[i * 3 + 1] = v[1];
    puntos[i * 3 + 2] = v[2];
  };

  poner(WRIST, [0, 0, 0]);
  // El plato de los nudillos, a 8 cm de la muñeca y 7 cm de ancho.
  poner(INDEX_MCP, suma(escalar(along, 0.08), escalar(across, -0.035)));
  poner(MIDDLE_MCP, escalar(along, 0.085));
  poner(13, suma(escalar(along, 0.082), escalar(across, 0.025)));
  poner(PINKY_MCP, suma(escalar(along, 0.075), escalar(across, 0.05)));
  // El pulgar sale del lado del indice y se separa de la palma.
  poner(1, suma(escalar(along, 0.02), escalar(across, -0.03)));
  poner(2, suma(escalar(along, 0.045), escalar(across, -0.055)));
  poner(3, suma(escalar(along, 0.065), escalar(across, -0.07)));
  poner(4, suma(escalar(along, 0.08), escalar(across, -0.085), escalar(palm, 0.01)));
  // Los cuatro dedos estirados, cada uno con sus tres falanges.
  const dedos = [
    { base: INDEX_MCP, lado: -0.035, largo: distanciaDedos },
    { base: MIDDLE_MCP, lado: 0, largo: distanciaDedos * 1.04 },
    { base: 13, lado: 0.025, largo: distanciaDedos * 0.96 },
    { base: PINKY_MCP, lado: 0.05, largo: distanciaDedos * 0.82 },
  ];
  for (const { base, lado, largo } of dedos) {
    for (let f = 1; f <= 3; f++) {
      poner(base + f, suma(escalar(along, largo * (0.5 + f * 0.17)), escalar(across, lado)));
    }
  }
  return { puntos, palm };
}

/** Proyeccion de pinhole: de metros en el marco de la camara a la imagen. */
function proyectar(puntos, distancia, aspect, focal = 1.16) {
  const imagen = new Float32Array(JOINT_COUNT * 3);
  for (let i = 0; i < JOINT_COUNT; i++) {
    const z = distancia + puntos[i * 3 + 2];
    imagen[i * 3] = 0.5 + ((focal / aspect) * puntos[i * 3]) / z;
    imagen[i * 3 + 1] = 0.5 + (focal * puntos[i * 3 + 1]) / z;
    imagen[i * 3 + 2] = puntos[i * 3 + 2];
  }
  return imagen;
}

console.log("Conversion de coordenadas de la mano\n");

prueba("la conversion es un giro, no una reflexion", () => {
  assert.equal(
    VIEW_DETERMINANT,
    1,
    "el determinante tiene que ser +1; con -1 la mano derecha se dibuja con la forma de una izquierda",
  );
});

prueba("la mano sintetica es de verdad una mano derecha", () => {
  // Dedos arriba (Y negativa en MediaPipe es arriba), palma hacia la camara
  // (Z negativa es hacia la camara).
  const { puntos, palm } = manoDerecha({ along: [0, -1, 0], across: [-1, 0, 0] });
  assert.deepEqual(
    palm.map((n) => Math.round(n) || 0),
    [0, 0, -1],
    "con los dedos arriba y el meñique a la izquierda de la imagen, la palma mira a la camara",
  );
  assert.ok(
    dot(knuckleNormal(puntos), palm) > 0,
    "el marco anatomico no cumple la regla de la mano derecha: la prueba no probaria nada",
  );
});

prueba("una mano derecha sigue siendo derecha despues de convertirla", () => {
  // Varias orientaciones, porque una reflexion sobre un eje se esconde
  // cuando la mano esta plana justo en el plano de ese eje.
  const orientaciones = [
    { along: [0, -1, 0], across: [-1, 0, 0] },
    { along: [0, 0, -1], across: [-1, 0, 0] },
    { along: [1, 0, 0], across: [0, 0, -1] },
    { along: [0, -1, 0], across: [0, 0, -1] },
    { along: [0, -0.7071, -0.7071], across: [-1, 0, 0] },
    { along: [0.5774, -0.5774, -0.5774], across: [-0.7071, 0, -0.7071] },
  ];
  const convertidos = new Float32Array(JOINT_COUNT * 3);
  for (const o of orientaciones) {
    const { puntos, palm } = manoDerecha(o);
    assert.ok(dot(knuckleNormal(puntos), palm) > 0, "mano mal construida");

    toViewSpace(puntos, convertidos);
    const normal = knuckleNormal(convertidos);
    const palmaEsperada = vectorToViewSpace(palm);
    assert.ok(
      dot(normal, palmaEsperada) > 0,
      `con la palma hacia [${palm.map((n) => n.toFixed(2))}] la normal de los nudillos se dio la vuelta: eso es una mano izquierda`,
    );
  }
});

prueba("estirar los dedos hacia la webcam los adentra en la escena", () => {
  // Mano derecha, palma hacia abajo, dedos apuntando a la camara: el gesto de
  // alcanzar algo que esta sobre la mesa. Z negativa en MediaPipe es hacia la
  // camara.
  const { puntos, palm } = manoDerecha({ along: [0, 0, -1], across: [-1, 0, 0] });
  assert.deepEqual(palm.map((n) => Math.round(n) || 0), [0, 1, 0], "la palma deberia mirar abajo");
  const convertidos = new Float32Array(JOINT_COUNT * 3);
  toViewSpace(puntos, convertidos);

  // En three, Z negativa se aleja del espectador. Las puntas tienen que
  // quedar mas lejos que la muñeca, no mas cerca.
  const zMuñeca = convertidos[WRIST * 3 + 2];
  const zPunta = convertidos[INDEX_TIP * 3 + 2];
  assert.ok(
    zPunta < zMuñeca - 0.05,
    `los dedos vuelven hacia la cara en vez de adentrarse: muñeca ${zMuñeca}, punta ${zPunta}`,
  );
});

prueba("el pulgar de la mano derecha queda a la izquierda de la vista", () => {
  // La prueba concreta que se puede repetir con la propia mano: derecha,
  // palma abajo, dedos al frente. El pulgar esta a la izquierda de quien mira.
  const { puntos } = manoDerecha({ along: [0, 0, -1], across: [-1, 0, 0] });
  const convertidos = new Float32Array(JOINT_COUNT * 3);
  toViewSpace(puntos, convertidos);
  assert.ok(
    convertidos[4 * 3] < -0.02,
    `el pulgar salio a la derecha (x=${convertidos[4 * 3]}): eso solo lo hace una mano izquierda`,
  );
});

prueba("un punto suelto cae donde lo pone la conversion completa", () => {
  // La mano dibujada se ancla retrocediendo desde la punta del indice con
  // `jointInViewSpace`, y su forma se dibuja con `toViewSpace`. Si los dos
  // dejan de coincidir, la punta del dedo deja de caer sobre el rayo del
  // puntero: apuntarias a un sitio y seleccionarias otro.
  const { puntos } = manoDerecha({ along: [0, -1, 0], across: [-1, 0, 0] });
  const convertidos = new Float32Array(JOINT_COUNT * 3);
  toViewSpace(puntos, convertidos);
  const suelto = [0, 0, 0];
  for (const articulacion of [0, 4, INDEX_TIP, 9, 17, 20]) {
    jointInViewSpace(puntos, articulacion, suelto);
    for (let eje = 0; eje < 3; eje++) {
      assert.ok(
        Math.abs(suelto[eje] - convertidos[articulacion * 3 + eje]) < 1e-6,
        `el punto ${articulacion} no coincide en el eje ${eje}`,
      );
    }
  }
});

console.log("\nProfundidad\n");

prueba("la distancia estimada es la distancia real", () => {
  const { puntos } = manoDerecha({ along: [0, -1, 0], across: [-1, 0, 0] });
  const aspect = 4 / 3;
  for (const real of [0.3, 0.45, 0.6, 0.9]) {
    const imagen = proyectar(puntos, real, aspect);
    const estimada = estimateCameraDistance(imagen, puntos, aspect);
    assert.ok(
      Math.abs(estimada - real) < real * 0.08,
      `a ${real} m estimo ${estimada.toFixed(3)} m`,
    );
  }
});

prueba("girar la mano no cambia la distancia estimada", () => {
  // Esto es lo que no cumplia medir la profundidad con una sola distancia 2D:
  // la mano girada se veia mas pequeña y por tanto "mas lejos" sin haberse
  // movido. Aqui la mano gira 60° sobre la vertical sin cambiar de sitio.
  const aspect = 4 / 3;
  const real = 0.5;
  const estimadas = [];
  for (const grados of [0, 20, 40, 60]) {
    const a = (grados * Math.PI) / 180;
    const { puntos } = manoDerecha({
      along: [0, -1, 0],
      across: [-Math.cos(a), 0, -Math.sin(a)],
    });
    estimadas.push(estimateCameraDistance(proyectar(puntos, real, aspect), puntos, aspect));
  }
  const min = Math.min(...estimadas);
  const max = Math.max(...estimadas);
  assert.ok(
    max - min < real * 0.05,
    `la distancia se movio de ${min.toFixed(3)} a ${max.toFixed(3)} m solo por girar la mano`,
  );
});

prueba("la proporcion de la imagen se tiene en cuenta", () => {
  // Sin corregir el aspecto, pasar la mano de vertical a horizontal cambiaria
  // la distancia estimada. Con un aspecto de 4:3 el error llegaria al 33 %.
  const aspect = 4 / 3;
  const real = 0.5;
  const { puntos: vertical } = manoDerecha({ along: [0, -1, 0], across: [-1, 0, 0] });
  const { puntos: horizontal } = manoDerecha({ along: [1, 0, 0], across: [0, -1, 0] });
  const a = estimateCameraDistance(proyectar(vertical, real, aspect), vertical, aspect);
  const b = estimateCameraDistance(proyectar(horizontal, real, aspect), horizontal, aspect);
  assert.ok(Math.abs(a - b) < real * 0.05, `vertical ${a.toFixed(3)} m, horizontal ${b.toFixed(3)} m`);
});

prueba("acercar la mano a la webcam la adentra en la escena", () => {
  const estirado = viewDepth(0.3);
  const reposo = viewDepth(REACH.rest);
  const recogido = viewDepth(0.6);
  assert.ok(
    estirado > reposo && reposo > recogido,
    `profundidades fuera de orden: estirado ${estirado}, reposo ${reposo}, recogido ${recogido}`,
  );
  assert.equal(reposo, REACH.restDepth, "en reposo la mano deberia estar a su profundidad de reposo");
});

prueba("la profundidad se queda dentro de sus topes", () => {
  for (const d of [0.01, 0.1, 0.2, 2, 10]) {
    const z = viewDepth(d);
    assert.ok(z >= REACH.near && z <= REACH.far, `con ${d} m salio ${z}`);
  }
  assert.equal(viewDepth(0), REACH.restDepth, "sin señal la mano se queda en reposo");
  assert.equal(viewDepth(NaN), REACH.restDepth, "un NaN no puede llegar a la escena");
});

// --------------------------------------------------------------------------
// El ancla de la mano dibujada.
//
// Con la mano libre se ancla por la punta del indice -es con lo que se apunta-
// y llevando una pieza por el centro de la palma, porque la punta se desploma
// al abrir la mano y moveria la pieza justo al soltarla. Las dos anclas tienen
// que coincidir con el punto del que sale el rayo, o el dedo dibujado apunta a
// un sitio y la pieza va a otro.
// --------------------------------------------------------------------------
console.log("\nAncla de la mano\n");

prueba("el centro de la palma esta dentro de la mano, no en la muñeca", () => {
  const { puntos } = manoDerecha({ along: [0, -1, 0], across: [-1, 0, 0] });
  const palma = palmInViewSpace(puntos, [0, 0, 0]);
  const muñeca = jointInViewSpace(puntos, 0, [0, 0, 0]);
  const punta = jointInViewSpace(puntos, INDEX_TIP, [0, 0, 0]);

  const dMuñeca = Math.hypot(...palma.map((v, i) => v - muñeca[i]));
  const dPunta = Math.hypot(...palma.map((v, i) => v - punta[i]));
  assert.ok(dMuñeca > 1e-4, "el centro de la palma no puede ser la muñeca");
  assert.ok(
    dMuñeca < dPunta,
    `deberia estar mas cerca de la muñeca (${dMuñeca.toFixed(3)}) que de la punta (${dPunta.toFixed(3)})`,
  );
});

prueba("el centro de la palma usa el mismo giro que el resto", () => {
  // Si `palmInViewSpace` se escribiera con otros signos, la mano llevando una
  // pieza se dibujaria en un sitio distinto del que apunta el rayo, y solo
  // llevando una pieza: un fallo que no aparece hasta que se agarra algo.
  const { puntos } = manoDerecha({ along: [0, -1, 0], across: [-1, 0, 0] });
  const girados = new Float32Array(JOINT_COUNT * 3);
  toViewSpace(puntos, girados);

  // El promedio de los cuatro puntos de la palma, calculado sobre los puntos
  // ya girados, tiene que dar lo mismo que girar el promedio.
  const PALMA = [0, 5, 9, 17];
  const esperado = [0, 1, 2].map(
    (eje) => PALMA.reduce((suma, j) => suma + girados[j * 3 + eje], 0) / PALMA.length,
  );
  const salio = palmInViewSpace(puntos, [0, 0, 0]);
  for (let eje = 0; eje < 3; eje++) {
    assert.ok(
      Math.abs(salio[eje] - esperado[eje]) < 1e-6,
      `eje ${eje}: salio ${salio[eje]} y se esperaba ${esperado[eje]}`,
    );
  }
});

// --------------------------------------------------------------------------
// Cadencia de inferencia, adelanto y perdida de la mano.
//
// Son aritmetica pura y viven aparte (input/cadence.ts) por el mismo motivo
// que la conversion de coordenadas: es la clase de cosa que se rompe sin que
// ninguna otra prueba se entere. Una cadencia mal regulada no da un error; da
// una mano que va a tirones en un telefono y perfecta en el portatil de quien
// la programo.
// --------------------------------------------------------------------------
console.log("\nCadencia y adelanto\n");

prueba("una inferencia barata lleva la cadencia al techo", () => {
  // 12 ms es lo que cuesta en un portatil con GPU.
  const { hz } = cadenceFor(12);
  assert.equal(hz, CADENCE.maxHz, `con 12 ms salio ${hz} Hz`);
});

prueba("una inferencia cara lleva la cadencia al piso", () => {
  // 80 ms es un celular de gama media sin delegado GPU.
  const { hz, wanted } = cadenceFor(80);
  assert.equal(hz, CADENCE.minHz, `con 80 ms salio ${hz} Hz`);
  assert.ok(wanted < CADENCE.minHz, "el crudo tiene que quedar por debajo del piso");
});

prueba("el gasto se respeta mientras la cadencia no toque un tope", () => {
  // La propiedad que define el regulador: costo por cadencia es el gasto
  // fijado. Si esto se cumple, el equipo no se queda sin nucleo haga lo que
  // haga el detector.
  //
  // La banda donde la cadencia no toca un tope es un costo entre 500/24 y
  // 500/10, o sea entre 20,8 y 50 ms. Los dos extremos quedan fuera a
  // proposito: en ellos la cadencia cae justo sobre el tope y el gasto se
  // sigue respetando, pero no por el regulador sino por el acotado.
  for (const costo of [25, 30, 40, 45]) {
    const { hz } = cadenceFor(costo);
    assert.ok(
      hz > CADENCE.minHz && hz < CADENCE.maxHz,
      `${costo} ms deberia caer entre los topes, salio ${hz} Hz`,
    );
    const gasto = (costo * hz) / 1000;
    assert.ok(
      Math.abs(gasto - CADENCE.duty) < 1e-9,
      `con ${costo} ms el gasto salio ${gasto.toFixed(3)} y no ${CADENCE.duty}`,
    );
  }
});

prueba("sobrecargado se distingue de justo-en-el-piso", () => {
  // Con solo el valor acotado los dos casos son 10 Hz y no hay forma de
  // separarlos, asi que la degradacion a una sola mano no se dispararia nunca
  // o se disparararia siempre. Por eso `cadenceFor` devuelve los dos.
  const justo = cadenceFor((CADENCE.duty * 1000) / CADENCE.minHz);
  const pasado = cadenceFor(200);
  assert.equal(justo.hz, pasado.hz, "los dos estan en el piso");
  assert.ok(justo.wanted >= CADENCE.minHz, "justo en el piso no es sobrecarga");
  assert.ok(pasado.wanted < CADENCE.minHz, "200 ms si es sobrecarga");
});

prueba("un costo absurdo no produce una cadencia absurda", () => {
  for (const costo of [0, -5, 1e9]) {
    const { hz } = cadenceFor(costo);
    assert.ok(
      hz >= CADENCE.minHz && hz <= CADENCE.maxHz,
      `con un costo de ${costo} salio ${hz} Hz`,
    );
  }
});

prueba("un costo que no es un numero no abre el porton de la cadencia", () => {
  // Esta es la que de verdad importa, y la encontro ella misma. Un NaN aqui no
  // da un error: da una cadencia NaN, y como `ahora - ultimo < NaN` es falso,
  // el porton que limita la inferencia se queda abierto y se vuelve a inferir
  // al ritmo de la camara en cualquier equipo. Silencioso y exactamente lo
  // contrario de lo que el regulador existe para hacer.
  for (const costo of [NaN, Infinity, -Infinity, undefined]) {
    const { hz } = cadenceFor(costo);
    assert.ok(Number.isFinite(hz), `con un costo de ${costo} salio ${hz}`);
    assert.equal(hz, CADENCE.startHz, `sin medicion valida hay que usar la de arranque`);
  }
  // Y el intervalo que sale de ella tiene que ser un numero, que es lo que el
  // porton compara de verdad.
  assert.ok(Number.isFinite(1000 / cadenceFor(NaN).hz));
});

prueba("un NaN no se cuela por el acotado de los demas", () => {
  // El mismo peligro en las otras dos: `NaN < min` y `NaN > max` son las dos
  // falsas, asi que un clamp obvio devuelve el NaN y queda convencido de
  // haberlo acotado. El minimo es el valor prudente en las dos: no adelantar
  // nada, y dar la mano por perdida antes.
  assert.equal(predictSeconds(NaN, 1), 0);
  assert.ok(Number.isFinite(lostWindowMs(NaN)));
});

prueba("acelerando o a velocidad sostenida se adelanta todo", () => {
  // La propiedad que importa: la guardia de frenada no cuesta nada en el caso
  // normal. Si recortara aqui, estaria quitando adelanto justo cuando el
  // adelanto es lo que cancela el retraso.
  assert.equal(leadScale(0.4, 0.4), 1, "velocidad sostenida");
  assert.equal(leadScale(0.4, 0.9), 1, "acelerando");
  assert.equal(leadScale(0, 0.5), 1, "una mano que acaba de aparecer");
});

prueba("frenando se adelanta menos, en proporcion a la frenada", () => {
  const medio = leadScale(1, 0.5);
  const fuerte = leadScale(1, 0.1);
  assert.ok(medio < 1, `frenar a la mitad deberia recortar, salio ${medio}`);
  assert.ok(fuerte < medio, `frenar mas deberia recortar mas: ${fuerte} vs ${medio}`);
});

prueba("el recorte por frenada tiene piso", () => {
  // Sin piso, una parada en seco deja el adelanto en cero y la mano vuelve a
  // ir un cuadro entero por detras -que es el problema que el adelanto
  // existe para resolver.
  for (const v of [0, 1e-9, 0.001]) {
    assert.equal(leadScale(1, v), BRAKE_FLOOR, `con velocidad ${v}`);
  }
});

prueba("el adelanto no pasa de su tope ni va hacia atras", () => {
  assert.equal(predictSeconds(500, 1), PREDICT_MS / 1000, "un cuadro muy viejo satura");
  // Un reloj que entregue algo del futuro daria una edad negativa, y adelantar
  // una edad negativa mueve el puntero hacia donde la mano ya estuvo.
  assert.equal(predictSeconds(-50, 1), 0, "una edad negativa no adelanta nada");
  assert.equal(predictSeconds(60, 1), 0.06, "dentro del tope adelanta la edad");
});

prueba("la ventana de perdida sigue a la cadencia", () => {
  // Atada a la cadencia y no a un numero fijo: a 10 Hz hay que aguantar mas
  // que a 24, o una deteccion perdida -ruido normal- apagaria la mano.
  const lenta = lostWindowMs(CADENCE.minHz);
  const rapida = lostWindowMs(CADENCE.maxHz);
  assert.ok(lenta > rapida, `a 10 Hz (${lenta} ms) deberia aguantar mas que a 24 (${rapida} ms)`);
  for (const hz of [CADENCE.minHz, 15, CADENCE.maxHz]) {
    const ventana = lostWindowMs(hz);
    const intervalo = 1000 / hz;
    assert.ok(
      ventana >= intervalo,
      `a ${hz} Hz la ventana (${ventana} ms) no puede ser menor que un intervalo (${intervalo.toFixed(0)} ms)`,
    );
  }
});

prueba("la mano no se sostiene media vida en una pose vieja", () => {
  // Lo que esto fija: antes eran 400 ms fijos, y una mano congelada en una
  // pose que ya no existe es peor que no dibujar nada, porque quien la ve
  // cree que el detector la sigue.
  for (const hz of [CADENCE.minHz, 15, CADENCE.maxHz]) {
    assert.ok(lostWindowMs(hz) <= 300, `a ${hz} Hz salio ${lostWindowMs(hz)} ms`);
  }
});

// --------------------------------------------------------------------------
// Que suelta una pieza, y que no.
// --------------------------------------------------------------------------
console.log("\nAgarrar y soltar\n");

prueba("abrir la mano suelta", () => {
  for (const antes of ["point", "pinch", "fist", "none"]) {
    assert.equal(opensHand(antes, "open"), true, `desde ${antes}`);
  }
});

prueba("es el flanco de abrir, no estar abierto", () => {
  // Esto es lo que impide que una pieza tomada con el contador se caiga en el
  // mismo instante de tomarla: apuntar es la mano casi abierta, y si contara
  // el estado y no el gesto de abrir, soltaria sola.
  assert.equal(opensHand("open", "open"), false, "seguir abierta no suelta");
});

prueba("nada mas suelta", () => {
  // Cerrar la mano, cambiar de agarre o perder la mano no sueltan: lo unico
  // que suelta es abrirla, a proposito. Una pieza que se cae sola al parpadear
  // el detector es peor que una que se queda pegada un segundo de mas.
  for (const antes of ["point", "open", "pinch", "fist", "none"]) {
    for (const despues of ["point", "pinch", "fist", "none"]) {
      assert.equal(opensHand(antes, despues), false, `${antes} -> ${despues}`);
    }
  }
});

// --------------------------------------------------------------------------
// El contador sobre los controles.
//
// `WidgetPointer` no necesita navegador: lo unico que toca de three es cruzar
// un rayo, y eso se le puede dar hecho. Vale la pena probarlo aqui porque es
// lo que decide si un boton se pulsa, y su fallo no da error -da un boton que
// no responde, que desde fuera parece que el detector no ve la mano.
// --------------------------------------------------------------------------
console.log("\nContador sobre los controles\n");

/** Un boton de mentira, registrado como lo registraria `useWidget`. */
function montarBoton(id = "boton") {
  widgets.clear();
  let pulsaciones = 0;
  const object = { userData: { widgetId: id } };
  widgets.set(id, {
    id,
    kind: "button",
    object,
    disabled: false,
    length: 1,
    activate: () => {
      pulsaciones += 1;
    },
  });
  // El rayo siempre acierta: lo que se prueba es el contador, no el cruce.
  const rayo = { intersectObjects: () => [{ distance: 2, object }] };
  return { rayo, pulsaciones: () => pulsaciones };
}

prueba("el contador se llena mientras se apunta", () => {
  const { rayo } = montarBoton();
  const p = new WidgetPointer();
  p.update(rayo, 1000, false, true);
  assert.equal(pointer.dwell, 0, "al llegar no lleva nada");
  p.update(rayo, 1000 + DWELL_MS / 2, false, true);
  assert.ok(
    Math.abs(pointer.dwell - 0.5) < 0.01,
    `a la mitad deberia ir por 0,5 y va por ${pointer.dwell}`,
  );
});

prueba("al completarse, pulsa", () => {
  const { rayo, pulsaciones } = montarBoton();
  const p = new WidgetPointer();
  p.update(rayo, 1000, false, true);
  p.update(rayo, 1000 + DWELL_MS - 1, false, true);
  assert.equal(pulsaciones(), 0, "antes de tiempo no");
  p.update(rayo, 1000 + DWELL_MS, false, true);
  assert.equal(pulsaciones(), 1, "al completarse si");
});

prueba("no se repite solo mientras se le sigue mirando", () => {
  // El caso que esto fija: sin guardia, quedarse apuntando a un boton lo
  // dispararia una vez por segundo para siempre.
  const { rayo, pulsaciones } = montarBoton();
  const p = new WidgetPointer();
  for (let t = 0; t <= DWELL_MS * 4; t += 50) p.update(rayo, 1000 + t, false, true);
  assert.equal(pulsaciones(), 1, `salieron ${pulsaciones()} pulsaciones`);
});

prueba("cerrar la mano pulsa en el acto, sin esperar", () => {
  const { rayo, pulsaciones } = montarBoton();
  const p = new WidgetPointer();
  p.update(rayo, 1000, false, true);
  p.update(rayo, 1010, true, true);
  assert.equal(pulsaciones(), 1, "el atajo tiene que ser inmediato");
  assert.equal(pointer.dwell, 0, "y deja el contador a cero");
});

prueba("con mouse no hay contador", () => {
  // Apuntar con el cursor no puede pulsar: ahi el click ya es deliberado, y
  // un boton que se dispara por pasar el raton por encima es un error.
  const { rayo, pulsaciones } = montarBoton();
  const p = new WidgetPointer();
  for (let t = 0; t <= DWELL_MS * 2; t += 50) p.update(rayo, 1000 + t, false, false);
  assert.equal(pulsaciones(), 0, `salieron ${pulsaciones()} pulsaciones`);
  assert.equal(pointer.dwell, 0, "ni se dibuja el anillo");
});

prueba("el contador vale para cualquier control, no solo para las piezas", () => {
  // Esto es lo que faltaba y costo encontrar: el contador estaba solo en las
  // piezas, y **en el editor no hay piezas**. El profesor se quedaba apuntando
  // a un boton que no se pulsaba nunca.
  const { rayo, pulsaciones } = montarBoton("env-next");
  const p = new WidgetPointer();
  p.update(rayo, 0, false, true);
  p.update(rayo, DWELL_MS, false, true);
  assert.equal(pulsaciones(), 1, "un boton del editor tiene que poder pulsarse asi");
});

// --------------------------------------------------------------------------
// El estabilizador de gestos, que ahora cuenta tiempo y no cuadros.
// --------------------------------------------------------------------------
console.log("\nEstabilidad del gesto\n");

prueba("un gesto no se acepta antes de sostenerse", () => {
  const s = new GestureStabilizer();
  // Un cuadro con ruido en medio de la nada no puede disparar un clic.
  assert.equal(s.push("pinch", 1000), "none", "al instante todavia no");
  assert.equal(s.push("pinch", 1050), "none", "a los 50 ms tampoco");
});

prueba("sostenido lo suficiente, se acepta", () => {
  const s = new GestureStabilizer();
  s.push("pinch", 1000);
  assert.equal(s.push("pinch", 1120), "pinch", "a los 120 ms ya");
});

prueba("un cuadro con ruido no interrumpe un gesto ya aceptado", () => {
  const s = new GestureStabilizer();
  s.push("pinch", 1000);
  s.push("pinch", 1120);
  // El ruido reinicia el candidato pero no borra lo aceptado: la pieza no se
  // cae porque un cuadro leyera mal la mano.
  assert.equal(s.push("none", 1140), "pinch", "un cuadro suelto no tumba el gesto");
  assert.equal(s.push("pinch", 1160), "pinch");
});

prueba("el umbral significa lo mismo a cualquier cadencia", () => {
  // Esta es la razon de que se cuente tiempo y no cuadros. Con tres cuadros
  // -lo que habia antes- el gesto tardaba 125 ms en un portatil a 24 Hz y
  // 300 ms en un celular a 10 Hz: el mismo codigo se sentia como dos
  // interfaces distintas, y el tiempo que una persona tarda en hacer un gesto
  // a proposito no depende de la cadencia del detector.
  const aceptadoEn = (hz) => {
    const s = new GestureStabilizer();
    const paso = 1000 / hz;
    for (let i = 0; i < 40; i++) {
      const t = 1000 + i * paso;
      if (s.push("pinch", t) === "pinch") return i * paso;
    }
    return Infinity;
  };
  const lento = aceptadoEn(10);
  const rapido = aceptadoEn(24);
  // La diferencia que queda es solo el redondeo al siguiente cuadro, que a
  // 10 Hz son 100 ms: nunca el triple, como pasaba contando cuadros.
  assert.ok(
    Math.abs(lento - rapido) <= 1000 / 10,
    `a 10 Hz tardo ${lento} ms y a 24 Hz ${rapido} ms`,
  );
});

if (fallos.length === 0) {
  console.log(`\n${hechas} pruebas, todas en verde.`);
} else {
  console.log(`\n${fallos.length} de ${hechas} pruebas fallaron:\n`);
  for (const { nombre, mensaje } of fallos) console.log(`  ${nombre}\n    ${mensaje}\n`);
  process.exitCode = 1;
}
