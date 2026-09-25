# Aula EAN Visual

Plataforma académica multijugador en WebXR. Hay tres salones. El profesor abre
una clase en uno, lo arma con las manos —entorno 360, mesa, piezas— y reparte un
código; los estudiantes entran desde una URL a un lobby con tres portales, ven
en cuál hay clase, escriben el código y entran. Todo con las manos por cámara y
voz espacial.

Web-first sobre TypeScript. Un mismo código sirve a PC y celular desde una URL.
El Quest 3 (WebXR Hand Input) entra en la fase 2; la capa de entrada ya está
preparada para recibirlo sin tocar el resto de la aplicación.

## Arranque rápido

```bash
npm install
cp .env.example .env     # en PowerShell: Copy-Item .env.example .env
npm run dev
```

Abre <http://localhost:5173>:

1. **Soy profesor** → el código que imprimió el servidor al arrancar, en qué
   salón abres, el nombre de la clase, cuántos estudiantes y cuánto dura →
   **Abrir la clase**. Aparece el código de la sala.
2. Entra a **armar el salón**: estás solo, con la mesa y los paneles del editor.
   Elige un entorno 360, colócalo, saca piezas y ponlas sobre la mesa.
3. **Revisar y comenzar**. Hasta ese momento el código no deja entrar a nadie.
4. En otra pestaña, **Soy estudiante** → correo y nombre → **Entrar a la
   experiencia**. Caes en el lobby, apuntas al portal de ese salón, escribes el
   código en el teclado y entras.
5. Al terminar, **Cerrar la clase** deja el salón libre para el siguiente.

Los dos caminos están separados a propósito: el estudiante no ve nada de crear
salones, y no necesita ningún código para entrar a la experiencia. El código
hace falta en el portal, no en la puerta de la calle.

### Quién puede crear salones

Solo el profesor, y lo decide el servidor. Dos reglas que no se pueden saltar
desde el cliente:

- **Crear un salón exige `TEACHER_CODE`.** Si lo dejas vacío en el `.env`, el
  servidor genera uno al arrancar y lo imprime en la consola. Fíjalo para que
  no cambie en cada reinicio.
- **El rol no se pide, se demuestra.** Crear el salón devuelve un `hostToken`
  que solo vive en el navegador del profesor. Quien entra con él es profesor;
  todos los demás son estudiantes, aunque manden `role: "teacher"` en la
  petición. `npm run test:acceso -w @aula/server` verifica justamente eso.

El salón sobrevive aunque no haya entrado nadie todavía y aunque todos salgan a
mitad de clase: se desecha a los 45 minutos vacío, o cuando vence el PIN a las
4 horas.

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor (2567) y cliente con recarga en caliente (5173) |
| `npm run build` | Compila el cliente a `apps/web/dist` |
| `npm start` | Servidor solo, sirviendo el cliente compilado en un único puerto |
| `npm run typecheck` | Verifica tipos en cliente y servidor |
| `npm run assets:hdri` | Reduce la carpeta `HDRI/` a entornos servibles |
| `npm run smoke -w @aula/server` | Dos participantes reales: poses, agarres, autoridad del servidor |
| `npm run test:acceso -w @aula/server` | Control de acceso de profesor y vida del salón |
| `npm run test:navegador` | La aplicación en un Chrome real, con capturas |
| `npm run tunnel` | Levanta el túnel de Cloudflare (ver más abajo) |

Las pruebas necesitan el servidor corriendo. Las de servidor aceptan una URL
para verificar que el túnel transporta también el WebSocket:
`npm run smoke -w @aula/server -- https://algo.trycloudflare.com profe2026`

### La prueba de navegador

`npm run test:navegador` abre un Chrome de verdad (usa el que ya está instalado,
vía `puppeteer-core`) y recorre la sesión completa: el profesor crea el salón,
entra a armarlo, elige un entorno 360, gira el paisaje con un deslizador, saca
un cubo del panel de objetos, lo lleva a la mesa, revisa y abre la sesión;
después un estudiante entra por PIN con las manos por cámara. Deja capturas en
`.capturas/`.

Los paneles del editor viven dentro del lienzo: no hay nodos del DOM que pulsar.
En desarrollo la propia interfaz publica `window.__aulaWidgets()`, que proyecta
cada control a coordenadas de pantalla, y la prueba pulsa ahí. Sin eso tendría
que barrer la pantalla a ciegas, tardando un minuto y pulsando de paso los
botones que encontrara.

Existe por una razón concreta: los fallos del render 3D y del worker de
MediaPipe se ven en el navegador como una pantalla negra, y ninguna prueba de
servidor los detecta. Dos aciertos suyos: que `room.state` llegaba `undefined` y
tumbaba el árbol de React, y que MediaPipe fallaba con *ModuleFactory not set*
por cargar la variante clásica de su runtime en un worker ESM.

Dos detalles que hacen la prueba real:

- El paso de agarrar espera a que el HUD diga **"Tienes:"**, y eso solo ocurre
  cuando el estado del servidor confirma `heldBy`. No comprueba que el cliente
  crea haber agarrado algo, sino que el servidor se lo concedió.
- Después comprueba que la pieza **se dibuja**: que su matriz no tiene valores
  que no sean números. Un solo NaN en el estado —un giro que el servidor nunca
  asignó, por ejemplo— deja la pieza en la escena, en su sitio, con su malla, y
  three la dibuja en cada cuadro sin pintar un píxel. Eso ya pasó una vez, y
  ninguna comprobación de posición lo nota.

## Qué hay dentro

```
apps/server/    API + Colyseus + PIN. Autoridad sobre la escena.
  state.ts        Estado sincronizado. Poses cuantizadas: ~48 B por participante.
  AulaRoom.ts     Sala: puntos, agarres, edición, validación de cada acción.
  tickets.ts      PIN → sala, y ticket de un solo uso para entrar.
  scene.ts        La escena de cada salón, y el imán que la ordena.
  environments.ts Catálogo de entornos 360, y su validación.

apps/web/       Cliente React + Three.js.
  input/          Capa de entrada abstracta. Ver abajo.
  scene/          Suelo, entorno 360, objetos, avatares, jugador local.
  ui3d/           El editor del profesor: paneles, botones y deslizadores en 3D.
  net/            API, Colyseus y voz con audio espacial.

scripts/hdri.mjs  Reduce las HDRI de 4K a algo que quepa por la red.
```

### El editor del profesor

Antes de abrir el salón, el profesor lo arma a solas. Todo se opera con las
manos y **nada de esa interfaz está en el DOM**: son paneles dentro de la escena
3D, porque tienen que estar donde apunta la mano, y algo en HTML encima del
lienzo no recibe el rayo del puntero.

```
   carrusel de entornos 360        objetos: esfera, cilindro, cubo
   ubicar el entorno               revisar y comenzar
                 deslizadores de giro del escenario
```

Los paneles están **anclados alrededor del puesto**, no pegados a la cabeza: un
menú que sigue la mirada marea. Para que se pueda llegar a ellos sin perder la
mano de cuadro, es la cámara la que sigue a la mano, y solo cuando la mano se
acerca al borde.

Un botón pensado para hand tracking no se pulsa como uno de mouse: la mano
tiembla y el pellizco a veces no se lee. Hay dos caminos para lo mismo —
pellizcar, o **sostener la mano encima** algo menos de un segundo—, y el anillo
que se va llenando alrededor del cursor es lo que hace que el segundo se
entienda sin explicarlo.

### El imán

Las piezas no flotan. Al arrastrarlas, el servidor las recorta a la zona
permitida —el tablero y una franja de piso alrededor—, las encaja en una
rejilla de 5 cm y las apoya en la superficie que les toca. La misma función
corre en el cliente, que predice mientras se arrastra; están duplicadas a
propósito y tienen que seguir iguales, o la pieza dará un salto justo al
soltarla, que es cuando más se nota.

Con seguimiento por cámara la profundidad es lo más impreciso que hay. Por eso
la pieza no va a una distancia deducida del tamaño de la palma, sino a donde el
rayo corta el tablero: se apunta a la mesa y la pieza cae ahí.

### Los tres salones y el lobby

Los salones son tres sitios fijos, como tres aulas de un pasillo, y cada uno
admite una clase a la vez. Eso es lo que hace que los portales del lobby tengan
a qué apuntar antes de que nadie tenga un código.

| Estado | Qué significa | ¿Se puede entrar? |
|---|---|---|
| Sala no disponible | Nadie ha abierto nada ahí | No |
| Profesor preparando la sala | La clase existe pero se está armando | No |
| Sala disponible | Abierta y todavía sin nadie | Sí |
| Clase en curso | Abierta y con estudiantes dentro | Sí |
| Sala llena | Sin cupo | No |

`GET /api/lobby` devuelve los tres estados, y el lobby lo pide cada cuatro
segundos: cuando un profesor abre una clase, su portal y su fila de la tabla
cambian solos. **El lobby nunca devuelve el código de nadie**: lo lee una
pantalla que todavía no tiene ninguno, y repartirlo ahí haría inútil pedirlo.

La tabla no tiene horario cargado de antemano. Solo se ve lo que existe: la
clase abierta, cuánto dijo el profesor que iba a durar y cuánto lleva. Un
horario escrito a mano que contradiga lo que de verdad está abierto es peor que
no tener horario.

Cerrar la clase no es un adorno: con tres salones, quien termina a las diez
dejaría el salón ocupado 45 minutos y el siguiente profesor no podría abrir.

### La cámara: fija, y solo mira

La cámara no se desplaza. Ni caminar, ni acercarse, ni moverse en X o en Z: se
queda en el puesto y lo único que cambia es hacia dónde mira, 180 grados en
horizontal y un recorrido más corto en vertical.

Y quien la mueve es el deslizador, nunca la mano directamente:

```
MediaPipe → puntos de la mano → pellizco → deslizador → giro de la cámara
```

Esa cadena importa. Una cámara pegada a la posición de la mano se mueve cada vez
que la mano tiembla y no hay forma de dejarla quieta; un deslizador se queda
donde lo sueltas. Los dos deslizadores están en pantalla durante toda la
experiencia —lobby y clase, estudiante y profesor— y se pueden ocultar sin que
la cámara deje de funcionar.

El arrastre con mouse sigue existiendo y escribe en el mismo valor: arrastrar
mueve el deslizador, y mover el deslizador mueve la vista.

### La capa de entrada

Todo dispositivo produce las mismas acciones; nada aguas abajo sabe de dónde
vinieron.

```
MediaPipe (cámara)  ┐
WebXR (fase 2)      ├──▶ capa de entrada ──▶ apuntar · seleccionar · agarrar
Mouse / toque       ┘                        soltar · levantar la mano
```

MediaPipe corre en un **Web Worker** separado del render: clasifica el gesto,
suaviza el puntero con un filtro One Euro y devuelve el resultado junto con los
**21 puntos de cada mano**, en el orden y con los nombres de MediaPipe, sin
renumerar. Son 63 números por mano; el vídeo no sale del dispositivo ni del
hilo del worker.

Los puntos se pueden ver en pantalla con **Mostrar puntos de la mano**, en los
controles de cámara. No es un adorno: sirve para ver por qué el detector no
encuentra una mano —mala luz, contraluz, la mano fuera de cuadro— y para
comprobar que izquierda y derecha son las que uno cree.

| Gesto | Acción |
|---|---|
| Índice extendido | Apuntar |
| Pellizco | Seleccionar, pulsar un botón, soltar la pieza que se lleva |
| Mano quieta sobre un botón | Pulsarlo, sin depender de ningún gesto |
| Puño cerrado | Agarrar y mover |
| Mano abierta | Soltar lo que se agarró con el puño |
| Mano arriba 1 s | Pedir la palabra |

Abrir la mano suelta lo que se agarró cerrando el puño. Una pieza recién sacada
del panel llega a una mano que nunca se cerró, así que para esa el gesto es el
pellizco: si bastara con abrir, se caería en el aire en el mismo instante de
aparecer.

Pellizcar pulsa siempre, aunque sea el mismo botón que la vez anterior: un
código con dos dígitos iguales seguidos se escribe pulsando dos veces sin mover
la mano. La espera sostenida sí lleva guardia —si no, quedarse mirando un botón
lo dispararía una vez por segundo—, así que para repetir por esa vía hay que
salir y volver.

## Infraestructura: el túnel y el audio

**Decisión de la fase 1: montaje híbrido.** Servidor propio detrás de un túnel
de Cloudflare para la app, la API y Colyseus; la voz por fuera del túnel.

La razón es concreta. WebXR y `getUserMedia` exigen HTTPS con certificado
válido, y el túnel lo entrega sin abrir puertos — justo el obstáculo más molesto
al probar desde el celular. Pero **un túnel HTTP no transporta el UDP de
WebRTC**, que es como LiveKit mueve la voz. El *signaling* sí pasaría, porque es
WebSocket, así que el síntoma engaña: la sala conecta, los avatares se mueven y
nadie se oye.

Por eso `LIVEKIT_URL` apunta fuera del túnel. Para la fase 1: **LiveKit Cloud,
plan gratuito** (cero operación, suficiente para 6 participantes). El cliente lee
esa variable, así que pasar a LiveKit auto-hospedado en la fase 2 es cambiar una
línea del `.env`, no reescribir nada.

### Levantar el túnel

```bash
winget install --id Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create aula-ean
cloudflared tunnel route dns aula-ean aula.TUDOMINIO.co
# edita tunnel/config.yml con el UUID y el hostname
npm run build && npm start     # todo en el puerto 2567
npm run tunnel                 # en otra terminal
```

Usa un **túnel con nombre** sobre un subdominio propio, no las URL efímeras de
`trycloudflare.com`: esas cambian en cada reinicio y reescribirlas en el Quest
es tedioso. Para una prueba de un rato, el túnel rápido sirve:

```bash
npm run build && npm start
cloudflared tunnel --url http://localhost:2567
```

### Voz

Crea un proyecto en <https://cloud.livekit.io> y copia las tres variables:

```
LIVEKIT_URL=wss://TU-PROYECTO.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

Sin ellas la sala funciona completa pero muda, y lo dice en el HUD en vez de
fallar en silencio.

## Presupuestos

| | Meta | Cómo |
|---|---|---|
| Pose por participante | ~48 B / tick | `t.quantized` de 16 bits, no `float32` |
| Frecuencia de estado | 20 Hz | `setPatchRate(50)` + interpolación en el receptor |
| Detección de manos | 15–30 fps | Worker aparte, cuadros a 320×240 |
| Triángulos por avatar | 2.500 | Cabeza, dos antebrazos, sin torso |

### Descarga inicial: medida, no estimada

| Pieza | Por la red | Nota |
|---|---:|---|
| WASM de MediaPipe | 3,29 MB | 11,21 MB sin comprimir |
| Modelo `hand_landmarker.task` | 7,46 MB | Desde el CDN de Google |
| JavaScript de la aplicación | 0,52 MB | 1,89 MB sin comprimir |
| Miniaturas del carrusel | 0,19 MB | Las tres juntas |
| CSS y HTML | 6 kB | |
| **Total** | **≈ 11,5 MB** | Presupuesto de celular: 15 MB |
| Un entorno 360, al elegirlo | 1,7 MB | No entra en la carga inicial |

Cabe, pero sin holgura, y **dos tercios son el detector de manos**. Tres cosas
que conviene saber:

- La compresión del servidor no es opcional. Sin `compression()` el WASM viaja
  a 11,21 MB y la fase 1 no cabe en su propio presupuesto.
- Ambos archivos quedan en caché del navegador: solo pesan la primera vez.
- En modo mouse no se descarga ninguno de los dos. Un estudiante sin cámara
  entra con medio megabyte.

Para una sala sin internet confiable, sirve el modelo desde el propio origen:

```bash
curl -L -o apps/web/public/models/hand_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
# y en .env del cliente:
VITE_HAND_MODEL_URL=/models/hand_landmarker.task
```

Eso además evita una petición a un tercero desde el dispositivo del estudiante.

### Los entornos 360

Las HDRI originales son 4K y pesan unos 25 MB cada una: 78 MB entre tres, contra
un presupuesto de 15 MB. `npm run assets:hdri` lee la carpeta `HDRI/` —que no va
al repositorio— y deja en `apps/server/public/hdri/`, por cada archivo:

- una versión equirectangular de 1024×512 en RGBE, ~1,7 MB, que es lo que aguanta
  un celular de gama media como mapa de entorno sin comerse los 30 fps;
- una miniatura de 256×128 tonemapeada, unas decenas de KB.

El carrusel solo descarga miniaturas. La HDRI completa baja cuando el profesor
elige ese entorno, con barra de progreso, y hasta que llega se sigue viendo lo
que había. Todo en Node puro: el script trae su propio lector y escritor de
Radiance y su propio codificador de PNG, porque una dependencia nativa más sería
una razón más para que el proyecto no compile en la máquina de al lado.

## Límites conocidos de la fase 1

Son deliberados, no pendientes olvidados:

- **Sin persistencia.** El PIN y los tickets viven en memoria. Redis y Supabase
  entran en la fase 2; la interfaz de `tickets.ts` no cambia.
- **Assets primitivos.** Esfera, cilindro y cubo. Poner un GLB es cambiar el
  campo `src` en `scene.ts`, sin tocar código; subirlos desde la interfaz es
  fase 3.
- **La escena no se guarda.** El profesor arma el salón cada vez. Persistir
  escenas es fase 3, junto con Supabase.
- **El correo del estudiante no se verifica.** Se comprueba la forma y nada más.
  Sin autenticación real es un dato declarado: filtrar por dominio daría una
  sensación de control que no existe. La autenticación entra con Supabase.
- **El lobby es de una sola persona.** No hay avatares de otros estudiantes
  entre los portales: no hay nada que sincronizar ahí todavía.
- **Sin seguimiento de cabeza.** La cámara vive en el punto asignado y la cabeza
  del avatar se inclina hacia donde apunta la mano. Suficiente para validar
  gestos; un rastreador de rostro costaría una segunda red neuronal.
- **Sin foco de audio.** Con 6 participantes no hace falta. Por encima de 8 hay
  que suscribirse solo a los más cercanos más el profesor.
- **Sin Quest 3.** Fase 2. La capa de entrada ya define dónde enchufarlo.
- **Sin tareas ni retroalimentación.** Fase 2, según la sección 08 del documento
  de arquitectura.

## Dónde retomar

[docs/siguiente-fase.md](docs/siguiente-fase.md) dice en qué punto quedó el
trabajo, qué falta para cerrar la fase 1 y qué viene en la fase 2.

## Qué medir antes de cerrar la fase 1

El criterio de éxito es *30 fps en celular de gama media y gestos usables sin
instrucciones largas*. El HUD muestra fps de render y de detección en vivo. Hay
que probarlo con los equipos reales de los estudiantes, no con un emulador:

1. ¿Se sostienen los 30 fps con 6 participantes y un entorno 360 puesto?
2. ¿Cuánto tarda alguien que nunca lo ha visto en agarrar y mover una pieza?
3. ¿Cuánto tarda un profesor en armar un salón completo, sin ayuda?
4. ¿Se pulsan los botones del editor con la mano, o hay que pellizcar tres veces?
5. ¿Aguanta la detección con luz de techo y con contraluz?
6. ¿A los cuántos minutos se cansa el brazo?
