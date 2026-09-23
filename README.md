# Aula EAN Visual — fase 1

Prueba de concepto de la plataforma académica multijugador en WebXR: habitación
blanca, tres assets, agarrar y mover con las manos por cámara, 5 estudiantes +
profesor con voz espacial.

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

1. **Soy profesor** → escribe el código que imprimió el servidor al arrancar →
   **Crear salón**. Aparece el PIN y el salón queda abierto.
2. Escribe tu nombre y entra a dar la clase.
3. En otra pestaña, **Soy estudiante** → ese PIN → otro nombre → entrar.

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
entra con mouse, apunta, agarra un objeto, lo mueve y lo suelta; después un
estudiante entra por PIN con las manos por cámara. Deja capturas en
`.capturas/`.

Existe por una razón concreta: los fallos del render 3D y del worker de
MediaPipe se ven en el navegador como una pantalla negra, y ninguna prueba de
servidor los detecta. Dos aciertos suyos: que `room.state` llegaba `undefined` y
tumbaba el árbol de React, y que MediaPipe fallaba con *ModuleFactory not set*
por cargar la variante clásica de su runtime en un worker ESM.

Un detalle que hace la prueba real: el paso de agarrar espera a que el HUD diga
**"Tienes:"**, y eso solo ocurre cuando el estado del servidor confirma
`heldBy`. No comprueba que el cliente crea haber agarrado algo, sino que el
servidor se lo concedió.

## Qué hay dentro

```
apps/server/    API + Colyseus + PIN. Autoridad sobre la escena.
  state.ts        Estado sincronizado. Poses cuantizadas: ~48 B por participante.
  AulaRoom.ts     Sala: puntos, agarres, validación de cada acción.
  tickets.ts      PIN → sala, y ticket de un solo uso para entrar.
  scene.ts        La escena de la fase 1, en el JSON declarativo del documento.

apps/web/       Cliente React + Three.js.
  input/          Capa de entrada abstracta. Ver abajo.
  scene/          Habitación, objetos, avatares, jugador local.
  net/            API, Colyseus y voz con audio espacial.
```

### La capa de entrada

Todo dispositivo produce las mismas acciones; nada aguas abajo sabe de dónde
vinieron.

```
MediaPipe (cámara)  ┐
WebXR (fase 2)      ├──▶ capa de entrada ──▶ apuntar · seleccionar · agarrar
Mouse / toque       ┘                        soltar · levantar la mano
```

MediaPipe corre en un **Web Worker** separado del render. Los 21 puntos por mano
nunca cruzan al hilo principal: el worker clasifica el gesto, suaviza el puntero
con un filtro One Euro y devuelve unos pocos números. El video no sale del
dispositivo.

| Gesto | Acción |
|---|---|
| Índice extendido | Apuntar |
| Pellizco | Seleccionar |
| Puño cerrado | Agarrar y mover |
| Mano abierta | Soltar |
| Mano arriba 1 s | Pedir la palabra |

Para acercar o alejar lo que tienes agarrado, mueve la mano hacia la cámara o
lejos de ella: el tamaño aparente de la palma controla la distancia.

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
| JavaScript de la aplicación | 0,50 MB | 1,76 MB sin comprimir |
| CSS y HTML | 6 kB | |
| **Total** | **≈ 11,3 MB** | Presupuesto de celular: 15 MB |

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

## Límites conocidos de la fase 1

Son deliberados, no pendientes olvidados:

- **Sin persistencia.** El PIN y los tickets viven en memoria. Redis y Supabase
  entran en la fase 2; la interfaz de `tickets.ts` no cambia.
- **Assets primitivos.** Caja, cilindro y caja. Poner un GLB es cambiar el campo
  `src` en `scene.ts`, sin tocar código.
- **Sin seguimiento de cabeza.** La cámara vive en el punto asignado y la cabeza
  del avatar se inclina hacia donde apunta la mano. Suficiente para validar
  gestos; un rastreador de rostro costaría una segunda red neuronal.
- **Sin foco de audio.** Con 6 participantes no hace falta. Por encima de 8 hay
  que suscribirse solo a los más cercanos más el profesor.
- **Sin Quest 3.** Fase 2. La capa de entrada ya define dónde enchufarlo.
- **Sin tareas ni retroalimentación.** Fase 2, según la sección 08 del documento
  de arquitectura.

## Qué medir antes de cerrar la fase 1

El criterio de éxito es *30 fps en celular de gama media y gestos usables sin
instrucciones largas*. El HUD muestra fps de render y de detección en vivo. Hay
que probarlo con los equipos reales de los estudiantes, no con un emulador:

1. ¿Se sostienen los 30 fps con 6 participantes en la sala?
2. ¿Cuánto tarda alguien que nunca lo ha visto en agarrar y mover la válvula?
3. ¿Aguanta la detección con luz de techo y con contraluz?
4. ¿A los cuántos minutos se cansa el brazo?
