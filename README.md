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
| `npm run test:manos` | Coordenadas, cadencia y gestos de la mano, sin navegador |
| `npm run test:navegador` | La aplicación en un Chrome real, con capturas |
| `npm run tunnel` | Levanta el túnel de Cloudflare (ver más abajo) |

Las pruebas necesitan el servidor corriendo, salvo `test:manos`, que es
aritmética pura y corre en un segundo. Las de servidor aceptan una URL para
verificar que el túnel transporta también el WebSocket:
`npm run smoke -w @aula/server -- https://algo.trycloudflare.com profe2026`

### La prueba de navegador

Monta su clase en el salón 2. Si estás probando a mano justo ahí, la prueba no
puede abrir y falla entera por algo que no tiene que ver con lo que probabas:
`SALON=3 npm run test:navegador` la manda a otro.

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

scripts/hdri.mjs            Reduce las HDRI de 4K a algo que quepa por la red.
scripts/vendor-mediapipe.mjs  Deja el runtime y el modelo en el servidor.
```

Dentro de `input/` hay dos módulos **sin una sola dependencia** —ni three, ni
DOM, ni MediaPipe— y están así a propósito: `handSpace.ts` (la conversión de
coordenadas y la profundidad) y `cadence.ts` (cada cuánto se infiere, cuánto se
adelanta, cuándo se da una mano por perdida). Son las dos partes que se rompen
sin que ninguna otra prueba se entere, y poder correrlas en un segundo sin
abrir un navegador es lo que evita descubrirlo en un salón de clase.

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

Los botones del editor se pulsan como todo lo demás: cerrando la mano encima.
Los deslizadores no se pulsan, se **enganchan**: cerrar la mano sobre el riel
lo prende de tu mano y la sigue hasta que la abras o te salgas de su eje. Un
botón se pulsa una vez; un deslizador se ajusta, y esa es la única diferencia
entre los dos.

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
punta del índice → engancharse → centro de la palma → giro de la cámara
```

Esa cadena importa. Una cámara pegada a la posición de la mano se mueve cada vez
que la mano tiembla y no hay forma de dejarla quieta; un deslizador se queda
donde lo sueltas. Los dos deslizadores están en pantalla durante toda la
experiencia —lobby y clase, estudiante y profesor— y se pueden ocultar sin que
la cámara deje de funcionar.

Los dos puntos de la mano hacen cosas distintas, a propósito. **Se apunta con
la punta del índice**, que es con lo que la gente señala; **se arrastra con el
centro de la palma**, que es el punto más estable de los veintiuno. Una punta
de dedo se dobla, se desplaza al cerrar la mano y tiene su propio temblor, y
arrastrar es justo donde eso se nota.

Y el riel **se engancha**: cierras la mano sobre él y de ahí en adelante va
prendido de tu mano y la sigue. Se suelta al abrirla o al irte de su eje. El arrastre es **relativo** —se recuerda
dónde estaba el mando y dónde la palma, y el mando se mueve lo que se mueva la
palma— porque estos rieles son dos barras de dieciséis píxeles en una esquina:
un mapeo directo metería los 180° de giro en el ancho de la barra y pediría
quedarse dentro de ella con una mano que tiembla.

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

#### Se apunta con el dedo, y la mano es el puntero

En los dos sitios el puntero sale de la **punta del índice**: señalar con el
dedo es el gesto que la gente hace sola. Lo que cambia es la marca en pantalla.

**Las manos se dibujan desde el lobby**, no desde que empieza la clase. Entrar
y ver tus manos es lo primero que dice que la experiencia va de manos; antes
había que escribir el código para tenerlas, con el detector ya funcionando y
sin nada que lo demostrara en pantalla. Las dibuja `OwnHands`, que usan el
lobby y el salón: tenerlo escrito dos veces sería tenerlo distinto en cuanto
alguien tocara uno de los dos.

| Dónde | Mano | Cursor |
|---|---|---|
| Lobby | **sí** | **sí** |
| Salón, clase en curso | **sí** | **sí** |
| Salón, profesor armando | **sí** | **sí** |
| Modo mouse | no | **sí** |

**Las dos marcas se ven siempre.** Antes se escondía una para que no hubiera
"dos punteros", y la regla sobraba. Tampoco se dibujaba la mano mientras el
profesor armaba el salón, con el argumento de que la pantalla es casi toda
paneles y la mano los tapa: el argumento era malo, porque es justo la pantalla
donde más se usa —se pulsa, se arrastra y se sacan piezas— y esconderla deja
sin saber si el detector la está viendo. Si tapan algo, lo que hay que mover
son los paneles.

Colocar y dibujar siguen siendo dos pasos separados en `OwnHands`, porque con
mouse no hay mano que dibujar pero su posición sí viaja en la pose.

Mano y cursor a la vez no se estorban, porque **caen sobre el mismo rayo**: la
mano se ancla al revés —primero dónde tiene que caer el punto con el que se
apunta, y después se retrocede hasta la muñeca—, así que el dedo y el cursor
quedan alineados en pantalla aunque estén a distintas distancias. La mano, a
medio metro; el cursor, allá donde el rayo toca. Sin ese anclaje invertido no
funcionaría: el cursor lleva una ganancia de 1,9 para que un movimiento corto
alcance toda la pantalla, mientras que la forma de la mano va en metros
reales.

Por eso, con la mano haciendo de puntero, se coloca al revés de lo normal:
primero se calcula dónde tiene que caer **la punta del índice** sobre el rayo,
y después se retrocede lo que esa punta se separa de la muñeca, que es por
donde se ancla el grupo. Así el dedo dibujado apunta exactamente a lo que se
va a seleccionar. Si `jointInViewSpace` y `toViewSpace` dejaran de coincidir
eso se rompería sin avisar, así que hay una prueba que lo sujeta.

#### La conversión de coordenadas, y por qué no es un espejo

La diferencia entre ver tu mano y ver su reflejo no está en dónde aparece,
sino en su **quiralidad**: si lo dibujado tiene
la forma de una mano derecha o de una izquierda. Y eso lo decide el
determinante de la conversión de ejes, no el signo de un eje suelto.

La conversión completa, de MediaPipe a la vista, es **un solo giro de 180°**
sobre el eje de la vista: `(−x, −y, +z)`. Son dos giros compuestos —cambio de
convención de ejes y cambio de punto de vista, porque la webcam está enfrente
mirándote y tú la miras a ella—, y su determinante es +1.

| Conversión | det | Qué se ve |
|---|---|---|
| `−x, −y, −z` | −1 | mano reflejada |
| `+x, −y, +z` | −1 | mano reflejada |
| `−x, −y, +z` | **+1** | la mano de quien la mueve |

Las dos primeras filas no son hipótesis: la segunda es lo que pasa si se quita
el giro horizontal creyendo que es el espejo. **Quitarlo no elimina el
reflejo, lo crea.** La cuenta vive aparte, en `handSpace.ts`, sin three ni DOM,
para poder probarla sin navegador:

```bash
npm run test:manos
```

Esa prueba construye manos derechas sintéticas en seis orientaciones y
comprueba que siguen siendo derechas al convertirlas. Hace falta porque este
fallo **no lo detecta ninguna prueba de posición**: la mano salía en su sitio,
del tamaño correcto y moviéndose en la dirección correcta. Lo único que estaba
mal era su forma.

#### Profundidad: la mano se adentra en la escena

La mano ya no está clavada a una distancia fija. Su distancia a la webcam se
estima comparando el tamaño **aparente** de los 21 puntos en la imagen contra
su tamaño **real** en metros, que es lo que da `worldLandmarks`. El ajuste es
por mínimos cuadrados sobre los 21 puntos, y usa solo las componentes
paralelas al plano de la imagen: así las dos medidas se encogen igual cuando
la mano gira y el cociente no se mueve. Medir la profundidad con una sola
distancia 2D —lo que hacía antes— hacía que la mano "se fuera" al girarla sin
haberse movido.

Y el signo sale del cuerpo, no de una preferencia: empujar la mano hacia la
pantalla la acerca a la webcam, que es **alejarla de los propios ojos**, así
que la mano se adentra en la escena hacia lo que hay sobre la mesa. Recogerla
contra el pecho la trae hacia la cara, donde se ve grande solo por
perspectiva: su tamaño en metros no cambia nunca.

#### Cada cuánto se infiere, y cómo se ajusta solo

La inferencia **no va al ritmo del render ni al de la cámara**. Va a la
cadencia que el propio detector decide midiendo lo que cuesta una inferencia
en ese equipo, y el render dibuja a 60 adelantando la última medición.

La regla es una división. Si una inferencia cuesta `d` ms, correrla `f` veces
por segundo gasta `d · f / 1000` de un núcleo; fijando ese gasto en la mitad,
la cadencia sale sola: `f = 500 / d`. En un portátil `d` ronda los 12 ms y la
cadencia se va al techo de 24 Hz; en un celular de gama media pasa de 40 ms y
baja al piso de 10, **sin medir el modelo del teléfono y sin mantener una
tabla de equipos que envejece**.

Bajar la cadencia no añade retraso, y eso es lo que la hace aceptable: cada
inferencia se corre sobre el cuadro **recién llegado**, así que lo único que
baja es cada cuánto se refresca, no cuánto tarda en llegar.

**Las dos manos se buscan siempre**, y eso no se negocia por rendimiento. Aquí
hubo un segundo escalón que pasaba a buscar una sola mano cuando la cadencia
llevaba un rato clavada en su piso. Ahorraba de verdad y está quitado de todos
modos: se encendía solo, en silencio, y dejaba sin la segunda mano justo a
quien tenía el equipo más justo. Un ahorro que apaga una función no es una
degradación elegante, es una función menos.

Todo esto se puede mirar, y hay que poder mirarlo: la vista de depuración
muestra la cadencia medida y la buscada, lo que cuesta una inferencia, el
retraso real de punta a punta, el delegado (GPU o CPU) y cuántas manos se
están buscando. El equilibrio entre fluidez y consumo no se ajusta a ciegas:
sin ver el costo no hay forma de saber si la cadencia bajó porque el equipo no
da o porque el regulador se pasó.

Los umbrales de confianza se quedan todos en el medio, y el primero tiene una
razón que costó encontrar: **`minHandDetectionConfidence` es también la puerta
por la que entra la segunda mano.** No filtra "cosas que no son manos", filtra
"manos que todavía no se seguían", y la segunda mano es exactamente eso.
Subirlo buscando menos falsos positivos hacía que costara aparecer. Contra el
ruido están el gesto sostenido y la ventana de pérdida, que no le cierran la
puerta a nada real.

El modelo y el runtime se sirven **desde el propio origen**, no del CDN de
Google. Son 7,5 MB que antes se bajaban en cada arranque en frío: en el wifi
de un campus eso es el primer cuello de toda la experiencia, y en una red que
filtre dominios externos no arranca en absoluto. Los deja ahí
`scripts/vendor-mediapipe.mjs`, que corre en `postinstall`; si no hay red al
instalar, avisa y el cliente se queda con el CDN como respaldo.

#### Retraso: se adelanta, no se suaviza más

El cuadro que se está dibujando se capturó hace rato —entre captura, detección
y mensaje de vuelta pasan fácil 100 ms—, y durante todo ese tiempo el cursor
dibuja donde **estaba** la mano. Bajar el suavizado solo reduce una parte de
ese retraso; aquí se cancela adelantando la posición por la velocidad que el
filtro One Euro ya calcula de paso, acotada a 120 ms. Con la mano quieta la
velocidad es cero, así que no añade ni un píxel de temblor.

El retraso se mide **desde que la cámara capturó el cuadro**, no desde que se
mandó al worker. `requestVideoFrameCallback` avisa una vez por cuadro de cámara
—no por refresco de pantalla, así que no se gasta nada procesando el mismo
cuadro dos veces— y de paso entrega el instante de captura. Sin eso, la
exposición y la cola de la cámara quedan fuera de la cuenta, el retraso medido
sale menor que el real y el adelanto corrige de menos. En el navegador que no
traiga ese aviso se estima, y la vista de depuración lo marca con un `~` para
no confundir una medición con la otra.

Y adelantar se recorta cuando la mano **frena**. El adelanto confía en que la
velocidad del último cuadro sigue valiendo; frenando en seco eso es falso —la
velocidad va suavizada y llega tarde al cambio— y el puntero se pasa de largo
y vuelve. Comparar la velocidad nueva contra la anterior dice cuándo está
pasando, porque es justo entonces cuando cae. Con la mano en movimiento
sostenido las dos coinciden y no se recorta nada: la guardia **no cuesta nada
en el caso normal**, que es la propiedad que la hace aceptable.

Los puntos se pueden ver en pantalla con **Mostrar puntos de la mano**, en los
controles de cámara. No es un adorno: sirve para ver por qué el detector no
encuentra una mano —mala luz, contraluz, la mano fuera de cuadro—, para
comprobar que izquierda y derecha son las que uno cree, y para leer la
distancia estimada de cada mano en metros, que es lo único de la profundidad
que no se puede juzgar a ojo.

La mano propia se dibuja desde el lobby: ver más abajo. No se dibuja mientras
el profesor **arma el salón**, porque ahí la pantalla es casi toda paneles y la
mano los tapa; vuelve al empezar la clase.

**De dónde sale el puntero depende de si llevas algo.** Con la mano libre, de
la punta del índice: señalar con el dedo es el gesto que la gente hace sola.
Con una pieza en la mano, del **centro de la palma** — porque la punta del
índice se desploma hacia la palma al abrir y cerrar la mano, así que con ella
mandando el propio gesto de soltar movería la pieza en el instante de
soltarla: aterrizaría donde no se apuntaba. La palma no se desplaza con los
dedos. El cambio no se nota porque ocurre cuando la pieza ya está tomada, y en
ese momento lo que se sigue con la vista es la pieza.

La marca de apuntar sobre el dedo **solo sale mientras se pellizca**.
Permanente no decía nada —la punta del índice ya es uno de los nudos grandes de
la mano dibujada— y competía con él por la atención. Apareciendo solo con el
pellizco pasa a querer decir algo: *esto es lo que voy a tomar*.

**Apunta y espera** a que se llene el anillo. Eso vale para **todo** lo que
responde —un botón, un deslizador, una pieza— y es la vía que siempre funciona,
porque no depende de que se lea ningún gesto. **Cerrar la mano** hace lo mismo,
pero ya.

| Control | Apuntar y esperar, o cerrar la mano | Se suelta |
|---|---|---|
| **Botón** | lo pulsa | — |
| **Deslizador** | lo **engancha**: queda prendido y sigue tu mano aunque la abras | cierras la mano otra vez, o te sales de su eje |
| **Pieza** | la toma | **abres la mano** |

Las dos vías hacen **lo mismo en todas partes**, y eso es lo que las hace
convivir. El conflicto que hubo aquí era otro: el mismo gesto significando
cosas distintas según dónde cayera —el pellizco pulsaba un botón pero *soltaba*
una pieza—, y eso sí había que quitarlo.

El contador estuvo un tiempo solo en las piezas, con el argumento de que un
botón se pulsa cerrando la mano y que escribir un código de seis dígitos
esperando 850 ms por tecla serían cinco segundos. El argumento es cierto y daba
igual: **en el editor no hay piezas**, solo botones y deslizadores, así que en
toda esa pantalla el contador no aparecía nunca y lo único que quedaba era el
gesto que peor lee el detector. El profesor se quedaba apuntando a un botón que
no se pulsaba. Por eso el contador es universal y el atajo es opcional, y no al
revés.

Un **deslizador** se ajusta, no se lleva: por eso se engancha. Sostener la mano
cerrada durante todo un recorrido cansa el brazo y el detector pierde el
pellizco a mitad de camino. Soltar un ajuste de cámara tiene que ser
deliberado; una pieza, en cambio, se te puede caer y no pasa nada.

Lo que suelta es **el gesto de abrir**, no estar abierto. Importa: apuntar es
la mano casi abierta, así que si contara el estado, una pieza tomada con el
contador se caería en el mismo instante de tomarla. Abrir del todo —los cinco
dedos— sí es un flanco, y es un gesto que nadie hace sin querer. Lo sujeta
`opensHand`, con su prueba.

Con mouse no hay contador ni gancho: el click toma y el click suelta, y el
deslizador se arrastra con el botón pulsado. No son dos interfaces —lo que se
ve es lo mismo, tomar y soltar—; es que el contador y el gancho existen **para
compensar un gesto que no se puede sostener**, y un botón de mouse sí se
sostiene.

La única excepción es que **una pieza recién tomada no se suelta en el mismo
gesto** (`SETTLE_MS`, 300 ms), porque tomar y soltar pueden caer juntos: con
mouse un clic es apretar y soltar casi a la vez.

**Pedir la palabra y soltar comparten gesto**, y lo único que los separa es la
altura. Por eso el detector se congela mientras llevas una pieza: soltar algo
en alto es abrir la mano en alto, y sin eso pedirías la palabra sin querer
cada vez que dejas una pieza en la parte de arriba del cuadro. Se congela en
vez de bajar la mano, porque quien ya la pidió no debería perderla por recoger
un cubo.

Cerrar la mano pulsa siempre, aunque sea el mismo botón que la vez anterior: un
código con dos dígitos iguales seguidos se escribe cerrándola dos veces sin
moverla. No hace falta guardia contra el repique porque se mira el **flanco**
—el instante en que la mano se cierra— y no el estado: con la mano ya cerrada,
barrer la fila de botones no dispara ninguno.

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

### La luz: un sol y un cielo, y nada más

El entorno 360 es **fondo, no luz**. Son dos cosas distintas y conviene que lo
sigan siendo.

Antes la foto hacía las dos: se asignaba a `scene.environment`, así que cada
material PBR de la escena la muestreaba en cada píxel. Y no era solo el
muestreo: asignar `scene.environment` hace que three genere un **PMREM** —un
mapa de entorno prefiltrado, con varias pasadas de desenfoque a textura— cada
vez que la foto cambia. Todo eso para iluminar una mesa, tres cubos y unos
avatares de colores planos.

Ahora la luz la ponen dos luces fijas:

- una **direccional** que hace de sol y da el volumen —sin ella una esfera y un
  cilindro del mismo color se ven igual—;
- una **hemisférica** que hace de cielo: aclara por arriba, oscurece por abajo
  y evita que las caras en sombra queden negras. Es luz ambiental, pero con
  dirección, y cuesta lo mismo.

Dos, siempre las mismas. Antes eran cuatro con la habitación en blanco y otra
configuración distinta con un entorno puesto: dos escenas que iluminar y la
cara se pagaba justo cuando ya había un paisaje detrás.

Los materiales pasaron de `MeshStandardMaterial` a `MeshLambertMaterial`. El
suelo es mate, la mesa es mate y los cubos son mates: todo el aparato PBR se
gastaba en calcular un reflejo especular que no se ve.

**No hay sombras en tiempo real**, y es deliberado: lo que hace entender dónde
está una pieza es el imán —que la apoya en la mesa o en el piso— y la rejilla
del suelo. Un mapa de sombras es una pasada entera de la escena por cuadro
para algo que ya está resuelto.

Lo que sí se queda es el **mapeo de tonos** mientras haya foto: es una cuenta
por píxel en el shader, barata, y sin ella un cielo con valores muy por encima
de 1 se ve como una mancha blanca.

Medido en la prueba de navegador, que corre sobre un renderizador por software
y por tanto exagera el coste de CPU: **de 10–12 fps a 27**.

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
