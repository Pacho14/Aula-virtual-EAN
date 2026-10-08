# Dónde quedamos

Última sesión: **7 de octubre de 2026**. Los dos caminos están separados: el
profesor abre una clase en uno de los tres salones y lo arma con las manos; el
estudiante entra con su correo a un lobby con portales, ve qué hay en cada
salón y entra escribiendo el código. Lo que falta para cerrar la fase no es
código: son mediciones en equipos reales.

La sesión del 7 de octubre fue entera sobre el tacto de las manos: la mano se
dibujaba reflejada, no tenía profundidad y el puntero iba por detrás de la
mano. Las tres cosas están corregidas y la conversión de coordenadas quedó
probada sin navegador. Lo que sigue sin confirmarse es cómo se siente en un
equipo de verdad.

## Para retomar

```bash
npm install          # repone node_modules, el runtime de MediaPipe y los entornos
npm run dev
```

Abre <http://localhost:5173>. El código de profesor está en el `.env` local
(`TEACHER_CODE`). Si clonaste el repo, copia `.env.example` a `.env` y pon uno:
sin eso el servidor genera uno al arrancar y lo imprime en la consola.

Los entornos 360 se generan desde la carpeta `HDRI/`, que **no está en el
repositorio** por peso: son 78 MB de archivos 4K. Las versiones reducidas sí
están versionadas, así que un clon funciona sin tener los originales. Para
añadir uno nuevo, deja el `.hdr` en `HDRI/` y corre `npm run assets:hdri`.

Antes de tocar nada, corre las tres pruebas para confirmar que sigues en verde:

```bash
npm run test:manos                   # la conversión de coordenadas de la mano
npm run smoke -w @aula/server        # salones, lobby, el imán, autoridad
npm run test:acceso -w @aula/server  # acceso de profesor y vida del salón
npm run test:navegador               # las dos personas, en un Chrome real
```

`test:manos` no necesita servidor ni navegador y tarda un segundo. Las otras
tres **cierran las clases que abren**. Si alguna se corta a medias, un salón
puede quedar ocupado 45 minutos: reinicia el servidor y vuelve a empezar.

## Lo que ya funciona y está verificado

**Entrada y roles**

- El estudiante entra con correo y nombre, sin ningún código, y cae en el lobby.
  El correo se valida solo en su forma; no hay autenticación todavía.
- El profesor mantiene su formulario: código de profesor, salón, nombre de la
  clase, cuántos estudiantes y cuánto dura. De ahí salen los puestos y el cupo.
- El rol lo sigue decidiendo el servidor con el `hostToken`. No se puede pedir.

**Lobby**

- Tres portales, uno por salón, con su estado: no disponible, preparando,
  disponible, en curso o llena. El color y el rótulo lo dicen sin leer la tabla.
- Tabla de clases al lado, que se refresca sola: clase, estado, cuánto dura,
  cuánto lleva y cuánta gente hay dentro.
- Apuntar a un portal abre un teclado numérico; sin el código no se entra. Un
  código de otro salón tampoco sirve.
- El lobby nunca reparte códigos, y la prueba lo comprueba.

**Cámara y manos**

- La cámara no se desplaza. Dos deslizadores en pantalla, siempre disponibles:
  horizontal de −90° a +90°, vertical más corto. Se pueden ocultar.
- Se manejan con el mouse, con el dedo, con el teclado y con un pellizco.
  La mano mueve el deslizador y el deslizador mueve la cámara, nunca al revés.
- Los 21 puntos de cada mano llegan al hilo principal y se pueden dibujar en
  pantalla para calibrar.
- La mano se dibuja **como la ve quien la mueve, no reflejada**. La conversión
  de ejes es un solo giro de 180° con determinante +1, vive aparte en
  `input/handSpace.ts` y la prueba `npm run test:manos` la comprueba con manos
  derechas sintéticas en seis orientaciones.
- La mano tiene **profundidad**: estirar el brazo hacia la pantalla la adentra
  en la escena, recogerlo la trae hacia la cara. La distancia sale de comparar
  el tamaño aparente de la mano contra su tamaño real en metros, así que no
  cambia al girar la mano.
- El puntero se **adelanta** por la velocidad que el filtro One Euro ya
  calcula, acotado a 90 ms, para cancelar el retraso del pipeline en vez de
  solo suavizarlo. Con la mano quieta no adelanta nada.
- Se apunta con la **punta del índice** en todas partes, y la regla es que
  siempre haya **exactamente un puntero a la vista**: la mano cuando se
  dibuja, y el cursor cuando no. Con la mano a la vista el cursor solo asoma
  mientras corre el contador. Sin mano —el lobby, el profesor armando el
  salón, el modo mouse— el cursor se ve siempre. Las dos marcas juntas no
  funcionan, porque el cursor lleva ganancia para alcanzar la pantalla y la
  mano va en metros reales: nunca caen en el mismo sitio.
- Para que el dedo dibujado apunte de verdad a lo que se selecciona, la mano
  se ancla al revés: primero dónde cae la punta del índice sobre el rayo, y
  después se retrocede hasta la muñeca. Lo sujeta una prueba.
- La mano no se dibuja mientras el profesor **arma el salón**: ahí la pantalla
  es casi toda paneles.
- **La espera sostenida vale ya para todo**: botones, piezas y deslizadores
  -los de cámara y los del editor. Apuntas, te quedas quieto, un anillo se
  llena y al completarse la pieza es tuya o el deslizador salta a donde
  señalas. Es la única vía que no depende de leer un gesto, que es lo que peor
  funciona con el detector a 5 Hz; antes los deslizadores exigían pellizcar sí
  o sí. El anillo solo se dibuja mientras el contador corre, y el punto de los
  deslizadores de cámara solo aparece encima de un riel.
- Pedir la palabra sigue siendo la mano abierta en alto 1 s, pero el detector
  se congela mientras se lleva una pieza: soltar algo en alto es abrir la mano
  en alto.

**Sala**

- El profesor arma el salón: carrusel de entornos 360, panel de transformación
  —posición X, Y, Z, rotación y escala—, panel de objetos y vista previa.
- Imán tipo Blender: las piezas se recortan a la zona permitida, encajan en una
  rejilla de 5 cm y se apoyan en la mesa o en el piso. Lo aplica el servidor.
- Cerrar la clase deja el salón libre para la siguiente.
- Todo lo de la fase 1: servidor autoritativo, avatares, detección de manos en
  un worker, túnel de Cloudflare.

## Lo que falta para cerrar la fase

El criterio sigue siendo *30 fps en celular de gama media y gestos usables sin
instrucciones largas*. Eso no se verifica desde esta máquina:

1. ¿Se sostienen los 30 fps con 6 participantes y un entorno 360 puesto?
2. ¿Se pellizca un deslizador de la cámara al primer intento, o hace falta
   insistir? Es el gesto que más se va a repetir de toda la experiencia.
3. ¿Cuánto tarda un estudiante en encontrar su portal y escribir el código?
4. ¿Cuánto tarda un profesor en armar un salón completo, sin ayuda?
5. ¿Aguanta la detección con luz de techo y con contraluz?
6. ¿A los cuántos minutos se cansa el brazo?
7. ¿**Se siente la mano propia, o se siente un muñeco**? Es lo que se arregló
   el 7 de octubre y no se puede medir desde esta máquina. Tres cosas que mirar
   por separado: que la mano no esté reflejada —el pulgar es la señal más
   rápida: con la palma abajo y los dedos al frente tiene que quedar del mismo
   lado que el tuyo—, que acercar y alejar el brazo mueva la mano en
   profundidad, y que el cursor no vaya por detrás de la mano.
8. ¿La profundidad cubre un rango útil? El recuadro de depuración muestra la
   distancia estimada de cada mano en metros, así que se compara con una
   cinta métrica y se acaba la discusión. Si sale escalada por un factor
   constante, el número a mover es `FOCAL` en `input/handSpace.ts`: depende
   del campo de visión de la webcam. Si dice **«sin profundidad»** no es un
   problema de calibración: significa que el ajuste salió negativo, es decir
   que los ejes X/Y de `worldLandmarks` no son paralelos a los de la imagen
   como se asume aquí. El rango cómodo se ajusta con `REACH`, en ese mismo
   archivo, donde cada constante dice qué significa.
9. ¿El adelanto del puntero se pasa de largo al frenar? Si se nota un rebote
   al parar la mano en seco, hay que bajar `PREDICT_MS` en `cameraSource.ts`;
   si sigue sintiéndose con retraso, subirlo.

Dos piezas siguen sin probarse con gente:

- **La voz.** El código está completo pero nadie lo ha oído funcionar: hace
  falta una cuenta de LiveKit Cloud (plan gratuito) y las tres variables del
  `.env`. Hasta entonces la sala funciona muda y lo dice en el HUD.
- **Más de seis participantes.** El cupo admite hasta doce, pero por encima de
  seis no está medido.

## Lo que sigue

Por orden de dependencia, no de dificultad:

1. **Quest 3.** La capa de entrada ya define dónde enchufar WebXR Hand Input, y
   ahora además entrega los 21 puntos por mano, que es lo que un visor espera
   manejar. Los paneles ya viven en el espacio y se pulsan sosteniendo la mano.
2. **Persistencia.** Redis para el mapa de códigos y Supabase para salones,
   escenas, horarios y eventos. Hoy el profesor arma el salón cada vez y la
   tabla del lobby solo muestra lo que está abierto: un horario del día de
   verdad necesita una base de datos detrás.
3. **Autenticación.** El correo del estudiante es un dato declarado y el
   profesor se identifica con un código compartido. Los dos salen con Supabase.
4. **Editor completo.** Falta ubicar assets en vista 2D, definir los puntos de
   estudiante a mano y congelar una versión publicada de la escena.
5. **Subida de assets.** GLB hasta 75 MB, con el pipeline de optimización y la
   barra de presupuesto. `scripts/hdri.mjs` es el precedente: reducir en el
   repositorio, servir desde el servidor, no meterlo en el bundle.
6. **Tareas y retroalimentación.** Colocar, seleccionar y secuencia, con el
   panel en vivo del profesor y el resumen al cerrar.

El documento de arquitectura tiene el detalle de cada una.

## Cosas que aprendimos construyendo, y conviene no olvidar

- **Lo que hace que una mano se vea reflejada es el determinante, no el signo
  de un eje.** Negar los tres ejes a la vez es una reflexión: la mano derecha
  se dibuja con la forma de una izquierda y los dedos estirados hacia la
  webcam salen apuntando a la propia cara. Lo tramposo es que el remedio
  intuitivo —quitar el giro horizontal, que es el que *parece* el espejo—
  vuelve a dejar el determinante en −1 y refleja la mano otra vez, además de
  invertir la dirección en que se mueve. La conversión correcta son dos giros
  compuestos, `(−x, −y, +z)`, determinante +1. Y hay una razón para que esto
  viviera meses sin que nadie lo viera: **ninguna prueba de posición lo
  detecta.** La mano salía en su sitio, del tamaño correcto y moviéndose en la
  dirección correcta; lo único mal era su forma. Por eso `handSpace.ts` no
  depende de three ni del DOM y `npm run test:manos` construye manos de las
  que ya se sabe la respuesta.
- **Suavizar menos no quita el retraso, solo una parte.** El cuadro que se
  dibuja se capturó hace 100 ms contando captura, detección y mensaje de
  vuelta; con el filtro al mínimo ese retraso sigue entero. Lo que lo cancela
  es adelantar por la velocidad —que el filtro One Euro ya calcula de paso— y
  acotar cuánto. Con la mano quieta la velocidad es cero, así que no cuesta
  nada en temblor: es gratis en el único caso donde suavizar importa.
- **Medir profundidad con una distancia 2D la hace cambiar al girar la mano.**
  Una mano girada se ve más estrecha y por tanto "más lejos" sin haberse
  movido. Hay que comparar lo aparente contra lo real *medido en el plano de
  la imagen*: las dos se encogen igual al girar y el cociente no se mueve.
- **Un NaN en el estado hace desaparecer un objeto sin dejar rastro.** El
  servidor creaba las piezas sin asignarles giro, el cliente recibía un ángulo
  que no era un número, y la matriz del objeto se llenaba de NaN: three lo
  dibujaba dieciocho veces por segundo sin pintar un solo píxel, con la malla en
  la escena, visible y en su sitio. Ninguna comprobación de posición lo detecta.
  Por eso la prueba de navegador verifica que la matriz sean números.
- **Un guardia contra el repique impide escribir dos dígitos iguales.** El botón
  no se dejaba pulsar dos veces sin mover la mano, y un código como 112233 era
  imposible. Pellizcar pulsa siempre; la espera sostenida sí lleva guardia.
- **Un rótulo transparente abre un agujero en el panel que tiene detrás.** Three
  ordena los transparentes por distancia, y con dos planos a cuatro milímetros
  ese orden lo decide el redondeo. Nada de la interfaz escribe profundidad y el
  orden se fija a mano.
- **Añadir un mapa a un material ya creado no recompila su shader.** Las
  miniaturas del carrusel se quedaban en blanco. Se montan cuando la textura ya
  existe.
- **Contar peticiones en vez de fallos deja fuera a la clase entera.** Un salón
  comparte la IP del campus, y quien espera reintenta cada pocos segundos. El
  límite cuenta intentos fallidos.
- **Con tres salones hace falta poder cerrarlos.** Sin eso, quien termina a las
  diez deja el salón ocupado 45 minutos y el siguiente profesor no puede abrir.
  Lo descubrió la prueba de navegador al correrla dos veces seguidas.
- **`joinById` no significa que haya estado.** Resuelve al abrirse el WebSocket.
  Leer `room.state` antes de esperarlo tumba el árbol de React entero. Por eso
  existe `firstState()`.
- **MediaPipe en un worker ESM necesita la variante de módulo** de su runtime
  (`forVisionTasks(path, true)`). Con la clásica falla con *ModuleFactory not
  set*.
- **El WASM de MediaPipe no puede vivir en el `public/` de Vite**, porque la
  librería lo carga con `import()` dinámico y Vite lo prohíbe. Lo sirve el
  servidor, que además es como queda en producción.
- **Un túnel HTTP no transporta el UDP de WebRTC.** La sala conecta, los
  avatares se mueven y nadie se oye. La voz va por fuera del túnel.
- **Sin `compression()` en el servidor**, la descarga inicial no cabe en su
  propio presupuesto.
- Los fallos del render 3D se ven como una pantalla negra y **ninguna prueba de
  servidor los detecta**. Para eso está `npm run test:navegador`.
