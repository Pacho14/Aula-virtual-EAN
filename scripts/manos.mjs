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
  toViewSpace,
  vectorToViewSpace,
  viewDepth,
} from "../apps/web/src/input/handSpace.ts";

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

if (fallos.length === 0) {
  console.log(`\n${hechas} pruebas, todas en verde.`);
} else {
  console.log(`\n${fallos.length} de ${hechas} pruebas fallaron:\n`);
  for (const { nombre, mensaje } of fallos) console.log(`  ${nombre}\n    ${mensaje}\n`);
  process.exitCode = 1;
}
