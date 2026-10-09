# Dónde quedamos

Última sesión: **8 de octubre de 2026**. Los dos caminos están separados: el
profesor abre una clase en uno de los tres salones y lo arma con las manos; el
estudiante entra con su correo a un lobby con portales, ve qué hay en cada
salón y entra escribiendo el código. Lo que falta para cerrar la fase no es
código: son mediciones en equipos reales.

La sesión del 7 de octubre fue entera sobre el tacto de las manos: la mano se
dibujaba reflejada, no tenía profundidad y el puntero iba por detrás de la
mano. Las tres cosas están corregidas y la conversión de coordenadas quedó
probada sin navegador.

La del 8 de octubre fue larga y tocó tres cosas: el **ritmo** del detector, la
**gramática** de la interacción y el **coste** de dibujar la escena. Lo que hay
que saber al volver:

**El detector**

- **La inferencia tenía un tope que no se aplicaba nunca.** El `targetFps: 60`
  solo valía en la rama de respaldo, y la que corre de verdad
  —`requestVideoFrameCallback`— se lo saltaba entero: se infería al ritmo de la
  cámara, 30 Hz, en cualquier equipo. Ahora la cadencia se regula midiendo lo
  que cuesta una inferencia, entre 10 y 24 Hz.
- **El retraso se medía desde el envío al worker, no desde la captura.** Así la
  exposición y la cola de la cámara quedaban fuera de la cuenta y el adelanto
  del puntero corregía de menos. Ahora sale de la marca de captura, y el
  adelanto subió a 120 ms con una guardia que lo recorta cuando la mano frena.
- **Las dos manos se buscan siempre.** Hubo un escalón que pasaba a una sola
  mano en equipos justos; está quitado, porque se encendía solo y dejaba sin la
  segunda mano justo a quien tenía el equipo más flojo.

**La interacción, que quedó en una sola frase**

- **Apunta y espera** a que se llene el anillo, **o cierra la mano**, que hace
  lo mismo pero ya. Vale para botones, deslizadores y piezas, en el salón y en
  el lobby.
- **Abrir la mano suelta** la pieza. Es el flanco de abrir, no estar abierto:
  apuntar es la mano casi abierta, y si contara el estado la pieza se caería al
  tomarla.
- Los **deslizadores se enganchan**: quedan prendidos de la mano aunque la
  abras, y se sueltan cerrándola otra vez o saliéndose de su eje.
- Las **manos se dibujan siempre que haya cámara**, también en el lobby y
  mientras el profesor arma el salón.

**La escena**

- El entorno 360 es **fondo, no luz**. La luz la ponen un sol y un cielo —dos
  luces fijas—, los materiales son Lambert y no hay sombras en tiempo real.
  Medido en la prueba de navegador: **de 10-12 fps a 27**.

Lo que sigue sin confirmarse es cómo se siente todo esto en un equipo de
verdad, y ahí hay algo nuevo que ayuda: la vista de depuración dice la
cadencia, el costo por inferencia y el retraso real.

**Lo primero que miraría mañana:** el detector de esta máquina va a **184 ms
por inferencia y 306 ms de retraso** con delegado GPU. El contador y el gancho
hacen que eso deje de bloquear, pero no lo arreglan. Son los números del
recuadro de depuración, arriba a la izquierda.

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
npm run test:manos                   # coordenadas, cadencia, gestos y soltar
npm run smoke -w @aula/server        # salones, lobby, el imán, autoridad
npm run test:acceso -w @aula/server  # acceso de profesor y vida del salón
npm run test:navegador               # las dos personas, en un Chrome real
```

`test:manos` son 32 pruebas y cubre cuatro cosas: la conversión de coordenadas,
la profundidad, el regulador de cadencia con su guardia de frenada, y qué
suelta una pieza y qué no. Todo lo que hay ahí es aritmética pura y vive en
módulos sin dependencias (`input/handSpace.ts` y `input/cadence.ts`) justo para
poder probarlo así.

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
  calcula, acotado a 120 ms, para cancelar el retraso del pipeline en vez de
  solo suavizarlo. Con la mano quieta no adelanta nada, y cuando la mano frena
  el adelanto se recorta para que no se pase de largo. La edad del cuadro se
  cuenta desde su **captura**, que es lo que hace que la corrección sea del
  tamaño del retraso de verdad.
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
- La mano se dibuja **siempre que haya cámara**, también mientras el profesor
  arma el salón.
- **El contador vale para todo**: botones, piezas y deslizadores -los de cámara
  y los del editor. Apuntas, te quedas quieto, se llena y al completarse el
  botón se pulsa, la pieza es tuya o el riel queda enganchado. Es la única vía
  que no depende de leer un gesto, que es lo que peor funciona con el detector
  a 5 Hz. Cerrar la mano hace lo mismo pero ya.
- **El contador se dibuja dos veces, y dicen cosas distintas**: el anillo del
  cursor dice *cuánto falta*, y el relleno del propio control -la barra que
  recorre un botón, el riel que se llena- dice *cuál*. Con cuatro botones en
  fila no es lo mismo. El anillo solo del puntito no se veía: es el error que
  nos costó dos rondas.
- **El contador vale para todo lo que responde**: botones, deslizadores y
  piezas. Cerrar la mano hace lo mismo pero ya. Las dos vías hacen *lo mismo*
  en todas partes, que es lo que las hace convivir -el conflicto de antes era
  el mismo gesto significando cosas distintas según dónde cayera.
- **El contador solo en las piezas no sirve de nada en el editor**, porque ahí
  no hay piezas: solo botones y deslizadores. Toda esa pantalla se quedaba sin
  la única vía que no depende de leer un gesto, y el profesor apuntaba a un
  botón que no se pulsaba. Cuando una ayuda se reparte "donde tiene sentido",
  hay que mirar **pantalla por pantalla** si en alguna no queda ninguna.
- **Lo que suelta es el gesto de abrir, no estar abierto** (`opensHand`). Si
  contara el estado, una pieza tomada con el contador se caería al tomarla,
  porque apuntar es la mano casi abierta.
- **Los deslizadores se enganchan**: con la mano, cerrar sobre el riel lo deja
  prendido y sigue siguiéndote aunque la abras; se suelta cerrando otra vez o
  saliéndose del eje. Con mouse no, que ahí el botón sí se sostiene.
- **Una sola regla para todo: cerrar la mano toma, abrirla suelta.** Botones,
  deslizadores y piezas, lo mismo. Pellizco y puño cuentan los dos como cerrar.
  La espera sostenida está quitada de todas partes. La única excepción es
  `SETTLE_MS`: una pieza recién tomada no se suelta en el mismo gesto.
- **La luz son dos luces fijas, no el entorno 360.** La foto es fondo; el sol y
  el cielo los ponen una direccional y una hemisférica. Materiales Lambert, sin
  sombras en tiempo real. Medido: de 10-12 fps a 27 en la prueba de navegador.
- **Las manos se dibujan siempre que haya cámara**, desde el lobby y también
  mientras el profesor arma el salón, con el mismo módulo (`scene/OwnHands.tsx`).
  La mano y el cursor se ven los dos: caen sobre el mismo rayo, así que en
  pantalla quedan alineados.
- **Los rieles de la cámara se enganchan y siguen la palma.** Se apunta con el
  índice, y una vez enganchado el arrastre es relativo: el mando se mueve lo
  que se mueva la palma, no salta a donde se apunta. Se suelta cerrando la mano
  o saliéndose del eje del riel.
- **Abrir la mano suelta la pieza.** Es el flanco de abrir, no estar abierto
  (`opensHand`): apuntar es la mano casi abierta, y si contara el estado la
  pieza se caería en el instante de tomarla con el contador.
- **El detector se adapta al equipo solo.** Cadencia entre 10 y 24 Hz según lo
  que cueste una inferencia. Las dos manos se buscan siempre. El modelo y el
  runtime se sirven desde el propio origen, no del CDN.
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
   al parar la mano en seco, hay que bajar `PREDICT_MS` en `input/cadence.ts`;
   si sigue sintiéndose con retraso, subirlo. Antes de tocarlo conviene mirar
   el retraso medido en la vista de depuración: si dice 70 ms, subir el tope a
   120 no cambia nada, porque solo se adelanta lo que el cuadro lleva de viejo.
   Y si el número va con un `~` delante, ese navegador no entrega la marca de
   captura y lo que se ve es un suelo, no la medida.
10. ¿La cadencia se queda donde debe? La vista de depuración muestra
    `medida/buscada Hz` y el costo por inferencia. Dos lecturas que significan
    cosas distintas: si la buscada está en 24 y la medida mucho más abajo, el
    cuello no es el regulador sino la inferencia misma; si la buscada está en
    10, este equipo tocó el piso y lo que falta es abaratar la inferencia, no
    el regulador. El número a mover es `duty` en `input/cadence.ts` —la
    fracción de un núcleo que se le permite gastar— y la regla sale de ahí.
11. ¿Se ve el contador en los cuatro sitios? Botones del editor, teclado del
    lobby, piezas de la mesa y rieles de cámara. Es la pregunta que más veces
    contestamos mal: el contador estaba puesto y **no se veía**, o estaba
    puesto en unos sitios y no en otros. Mirar los cuatro, uno por uno.
12. ¿Engancharse a un riel se entiende sin que nadie lo explique? Es el cambio
    de interacción más grande de la sesión. Tres cosas por separado: que se
    note que el riel quedó tomado -se pone magenta-, que el recorrido de la
    palma sea el adecuado (`RECORRIDO` en `CameraControls.tsx`: bajarlo si se
    siente pesado, subirlo si se siente nervioso), y que soltar cerrando la
    mano se descubra solo o haya que decirlo.
13. ¿Los 180 ms del pellizco son los correctos? Es `PINCH_HOLD_MS` en
    `LocalPlayer.tsx`. Si se lleva piezas sin querer, subirlo; si pellizcar se
    siente lento, bajarlo. Y si el problema es que el pellizco no se lee en
    absoluto, ese no es este número sino el umbral de `classify`.

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
- **Una tarea de MediaPipe por worker, y no hay segunda.** Cerrar una tarea se
  lleva consigo el módulo WASM del worker, así que crear otra después falla con
  el mismo *ModuleFactory not set* — y volver a resolver el fileset no lo
  arregla, que fue lo primero que probamos. Lo tramposo es cuándo se nota: a
  veces no revienta al crear sino en el primer cuadro, así que todo parece
  haber ido bien y lo que queda es un detector que no detecta. Para cambiar de
  configuración se levanta un worker nuevo y se tira el viejo. Cómo lo
  encontramos vale tanto como el qué: el aviso salía **cada tres segundos
  clavados**, que es exactamente el periodo con el que el regulador reintentaba
  degradar. Un error periódico está diciendo quién lo llama.
- **Un umbral contado en cuadros cambia de significado solo** en cuanto la
  cadencia deja de ser fija. Al hacer que la inferencia se regule entre 10 y
  24 Hz, "tres cuadros" para aceptar un gesto pasaron a ser 300 ms en un
  celular y 125 en un portátil: el mismo código se sentía como dos interfaces
  distintas, y el tiempo que una persona tarda en hacer un gesto a propósito no
  depende de la cadencia del detector. Los umbrales de gesto y de memoria de
  muñeca se cuentan en milisegundos, y hay una prueba que compara las dos
  cadencias.
- **Un NaN tampoco da error cuando lo que envenena es un tope.** `NaN < min` y
  `NaN > max` son las dos falsas, así que un `clamp` escrito de la manera obvia
  devuelve el NaN intacto y queda convencido de haberlo acotado. Con la
  cadencia en NaN, el portón que limita la inferencia pregunta si pasó
  suficiente tiempo, la comparación sale falsa, y **el portón se queda
  abierto**: el detector vuelve a correr al ritmo de la cámara en cualquier
  equipo, que es justo lo contrario de lo que el regulador existe para hacer, y
  sin un solo error en la consola. Lo encontró una prueba que probaba valores
  absurdos por costumbre, no por sospecha. Una media móvil es además un
  acumulador: un solo NaN se queda en ella para siempre.
- **El reloj de un worker no es el del documento.** `performance.now()` dentro
  de un worker cuenta desde que el worker se creó, así que un instante medido
  allí no se puede comparar con uno medido acá. Las marcas que tocan el
  filtrado viajan desde el hilo principal; lo único que se mide dentro es una
  *duración*, que sí es comparable porque es una diferencia.
- **Vite no reenvía `console.info` del navegador a la terminal.** Medio minuto
  perdido creyendo que una degradación no se había disparado cuando lo que
  pasaba era que su rastro no llegaba. `console.warn` sí se reenvía.
- **`minHandDetectionConfidence` es también la puerta de la segunda mano.** Lo
  subimos a 0,65 buscando menos falsos positivos y el efecto que no vimos venir
  fue que, con una mano ya detectada, a la otra le costaba aparecer: el umbral
  no filtra "cosas que no son manos", filtra "manos que todavía no se seguían",
  y la segunda mano es justo eso. Contra el ruido sirven el gesto sostenido y
  la ventana de pérdida, que no le cierran la puerta a nada real.
- **Un ahorro que apaga una función no es degradación elegante.** El segundo
  escalón —pasar a buscar una sola mano cuando el equipo no daba— ahorraba de
  verdad y está quitado igual: se encendía solo, en silencio, y dejaba sin la
  segunda mano justo a quien tenía el equipo más justo. Lo que queda regulando
  es la cadencia, que es además de donde salía casi todo el ahorro.
- **Dos clientes a la vez, para probar sin pisar a quien está probando.** Con
  los tres salones ocupados a mano no hay dónde montar la prueba de navegador.
  La salida es levantar una pila aparte: `PORT=2600 npm start` y un Vite propio
  con `VITE_SERVER_PORT=2600 npx vite --port 5174`, y pasarle esa URL a la
  prueba. Lo que **no** funciona es apuntarla al cliente compilado: la sonda
  `__aulaWidgets` en la que se apoya vive tras `import.meta.env.DEV`, así que en
  producción no existe y fallan todos los pasos de la interfaz a la vez -un
  síntoma que parece una regresión enorme y es solo el modo de compilación.
- **Asignar `scene.environment` no es "usar la foto de luz", es generar un
  PMREM.** three prefiltra el mapa de entorno con varias pasadas de desenfoque
  a textura cada vez que la foto cambia, y además cada material PBR lo muestrea
  por píxel. Todo eso iluminaba una mesa, tres cubos y unos avatares de colores
  planos. Separar fondo de luz -la foto se ve, la luz la ponen un sol y un
  cielo- y bajar los materiales a Lambert llevó la prueba de navegador de 10-12
  fps a 27. El fondo no se tocó: se ve igual.
- **Dos iluminaciones distintas cuestan el doble de pensar y el doble de
  mantener.** Había una configuración para la habitación en blanco (cuatro
  luces) y otra para cuando había entorno (una ambiente más el mapa de
  entorno), y la cara se pagaba justo en el caso con paisaje, que ya era el
  caro. Ahora son las mismas dos luces siempre y lo único que cambia es la
  intensidad, que es un número.
- **El render y el detector comparten hilo.** Abaratar la escena *es* acelerar
  las manos: no son dos problemas, son el mismo presupuesto. Por eso la vista
  de depuración, que redibujaba el vídeo y los 21 puntos **sesenta veces por
  segundo** cuando el detector entrega entre cinco y veinticuatro, ahora solo
  repinta cuando hay una medición nueva (`sampledAt` en el cuadro de entrada).
  Era trabajo de depuración compitiendo con lo que depura.
- **Tomar y soltar pueden caer en el mismo gesto.** Al unificar los controles
  en "cerrar la mano toma, abrir suelta", una pieza sacada del panel con un
  clic de mouse se soltaba en el acto: el `up` del propio clic ya era un
  "abrir". Con la mano pasa lo mismo si el detector pierde el pellizco un
  cuadro justo después de coger algo. La regla que lo arregla es una sola y
  vale para los dos: **una pieza recién tomada no se suelta en el mismo
  gesto** (`SETTLE_MS`). De paso, el mouse funciona solo como clic para tomar y
  clic para soltar, sin una línea que pregunte de qué dispositivo venimos.
- **Un material sin `transparent` y con `depthWrite: false` se dibuja debajo de
  todo.** three pinta primero la cola de opacos y después la de transparentes,
  así que un cursor opaco entra en la primera; y sin escribir profundidad, todo
  lo que se pinte después lo tapa. Con `renderOrder` negativo encima, se pintaba
  de los primeros. Así desapareció el cursor del lobby entero, y lo que parece
  lo contrario es lo correcto: **transparente y con `renderOrder` alto** para
  salir el último y quedar delante.
- **Dos maneras de hacer lo mismo no son el doble de fácil.** Las piezas se
  podían tomar pellizcando *o* apuntando y esperando a que se llenara un
  anillo. Parecía generosidad y era confusión: son dos reglas que aprender, y
  la que el HUD enseñaba era la lenta. Quitada la espera sobre las piezas, la
  regla cabe en una línea —pellizca para tomar, abre la mano para soltar— y el
  ruido lo sigue filtrando el estabilizador de gestos, que ya pedía sostener el
  gesto 100 ms. La espera sostenida se queda donde sí hace falta: botones y
  rieles, donde no compite con ningún gesto.
- **El texto en pantalla es parte del comportamiento.** Cambiamos la regla de
  agarrar y el HUD siguió enseñando la vieja, así que desde fuera *no había
  cambiado nada*: la aplicación seguía diciendo "apunta y espera" mientras el
  pellizco ya funcionaba. Un cambio de interacción no está hecho hasta que lo
  dice la línea de ayuda.
- **Una prueba que fija el salón choca con quien está probando a mano.** La de
  navegador ya aceptaba `SALON=`; la de servidor no, y fallaba entera —con
  siete pasos en rojo— solo porque había una clase abierta en el salón 2. Los
  dos números fijos que quedaban (el salón que se comprueba libre y el "portal
  equivocado") también tuvieron que derivarse, o correr en el salón 3 rompía la
  comprobación por existir y no por un fallo real.
- **La mezcla aditiva es invisible sobre fondo claro.** Es lo correcto para la
  mano dibujada -da el resplandor gratis- y lo peor posible para el cursor del
  lobby, que tiene detrás un fondo casi blanco: sumar cian sobre blanco no
  cambia nada, y el cursor desapareció en el único sitio donde es el único
  puntero que hay. Lo que vale en los dos extremos no es un color, es
  **contraste propio**: núcleo opaco y contorno oscuro.
- **Un relleno no aparta lo que no cabe.** Los deslizadores flotan fijos sobre
  todo, y en la pantalla de entrada caían sobre el botón de entrar. El primer
  arreglo fue rellenar por abajo, y no sirvió de nada: la tarjeta es más alta
  que la ventana, así que apartarla por dentro no la aparta de nada. Lo que
  funciona es **quitarle la franja al área del formulario** y darle
  desplazamiento propio, para que ninguno de los dos dependa de lo alto que sea
  el otro. Y se vio midiendo rectángulos en un Chrome de verdad a dos tamaños,
  no mirando la pantalla: a 1280x800 el choque se notaba poco y a 412x870 eran
  dos.
- **Un envío a 20 Hz y un `publish` inmediato no conviven.** El editor manda la
  colocación del entorno veinte veces por segundo, así que al pulsar "comenzar"
  podía quedar un último ajuste sin mandar. No era un retraso de 50 ms: los
  mensajes llegan en orden, `publish` entraba primero y a partir de ahí el
  servidor descarta los cambios de entorno —con razón—, así que el ajuste se
  perdía sin un solo error. El profesor dejaba el paisaje donde lo quería y la
  clase abría con el de un instante antes. Cualquier cosa que se envíe
  acumulada necesita un vaciado explícito antes del mensaje que cierra la fase.
- **El WASM de MediaPipe no puede vivir en el `public/` de Vite**, porque la
  librería lo carga con `import()` dinámico y Vite lo prohíbe. Lo sirve el
  servidor, que además es como queda en producción.
- **Un túnel HTTP no transporta el UDP de WebRTC.** La sala conecta, los
  avatares se mueven y nadie se oye. La voz va por fuera del túnel.
- **Sin `compression()` en el servidor**, la descarga inicial no cabe en su
  propio presupuesto.
- Los fallos del render 3D se ven como una pantalla negra y **ninguna prueba de
  servidor los detecta**. Para eso está `npm run test:navegador`.
