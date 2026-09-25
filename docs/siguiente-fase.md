# Dónde quedamos

Última sesión: **25 de septiembre de 2026**. El profesor ya arma el salón con
las manos antes de empezar la clase: elige un entorno 360, saca piezas y las
pone sobre la mesa, y solo entonces abre el PIN. Lo que falta para dar la fase
por cerrada no es código: son mediciones en equipos reales.

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
npm run smoke -w @aula/server        # editar, el imán, autoridad del servidor
npm run test:acceso -w @aula/server  # acceso de profesor y vida del salón
npm run test:navegador               # la app en un Chrome real, con capturas
```

## Lo que ya funciona y está verificado

- El profesor crea el salón con nombre y número de estudiantes; de ahí salen los
  puestos, repartidos en arco frente a la mesa, y el cupo de la sala.
- Fase de edición: el salón existe pero no recibe a nadie. Quien llega antes ve
  que el profesor está preparando la sala y entra solo cuando abre.
- Editor por hand tracking, todo dentro de la escena 3D: carrusel de entornos
  360, panel de objetos, ubicación del entorno, dos deslizadores de giro y una
  vista previa con el PIN antes de comenzar.
- Botones que se pulsan pellizcando **o** sosteniendo la mano encima.
- Imán tipo Blender: las piezas se recortan a la zona permitida, encajan en una
  rejilla de 5 cm y se apoyan en la mesa o en el piso. Lo aplica el servidor.
- Entorno 360 anclado al punto medio del escenario, que solo gira con los
  deslizadores; nunca sigue a la cámara.
- La cámara sigue la mano para que no se salga de cuadro.
- Suelo únicamente: la caja blanca desapareció al entrar los entornos.
- Todo lo de la fase 1 que ya estaba: agarrar y mover con servidor autoritativo,
  avatares de medio cuerpo, detección de manos en un worker, túnel de Cloudflare.

## Lo que falta para cerrar la fase

El criterio es *30 fps en celular de gama media y gestos usables sin
instrucciones largas*. Eso no se puede verificar desde esta máquina. Hay que
salir a medir, con los teléfonos que realmente tienen los estudiantes:

1. ¿Se sostienen los 30 fps con 6 participantes y un entorno 360 puesto? El HUD
   muestra fps de render y de detección en vivo.
2. ¿Cuánto tarda un profesor en armar un salón completo, sin ayuda?
3. ¿Se pulsan los botones del editor con la mano, o hay que insistir?
4. ¿Cuánto tarda alguien que nunca lo ha visto en agarrar y mover una pieza?
5. ¿Aguanta la detección con luz de techo y con contraluz?
6. ¿A los cuántos minutos se cansa el brazo?

Dos piezas siguen sin probarse con gente:

- **La voz.** El código está completo pero nadie lo ha oído funcionar, porque
  hace falta una cuenta de LiveKit Cloud (plan gratuito) y poner las tres
  variables en el `.env`. Hasta entonces la sala funciona muda y lo dice en el
  HUD.
- **Más de seis participantes.** El cupo admite hasta doce, pero por encima de
  seis no está medido.

## Lo que sigue

Por orden de dependencia, no de dificultad:

1. **Quest 3.** La capa de entrada ya define dónde enchufar WebXR Hand Input; es
   una fuente más junto a la cámara y el mouse. El editor está hecho de paneles
   en el espacio y botones que se pulsan sosteniendo la mano, así que debería
   pasar a un visor sin rediseñarlo.
2. **Persistencia.** Redis para el mapa de PIN y Supabase para salones, escenas
   y eventos. Hoy el profesor arma el salón cada vez: guardar una escena y
   volver a abrirla es lo primero que va a pedir. La interfaz de `tickets.ts`
   está pensada para que no cambie.
3. **Editor completo.** Lo que hay cubre entorno y primitivas. Falta ubicar
   assets en vista 2D, definir los puntos de estudiante a mano, y congelar una
   versión publicada de la escena.
4. **Subida de assets.** GLB hasta 75 MB, con el pipeline de optimización y la
   barra de presupuesto que bloquea publicar si la escena se pasa de peso. El
   script `scripts/hdri.mjs` es el precedente: reducir en el repositorio, servir
   desde el servidor, no meterlo en el bundle.
5. **Tareas y retroalimentación.** Colocar, seleccionar y secuencia, con el panel
   en vivo del profesor y el resumen al cerrar.
6. **Autenticación de profesor.** Sustituye el `TEACHER_CODE` del `.env`.

El documento de arquitectura tiene el detalle de cada una.

## Cosas que aprendimos construyendo, y conviene no olvidar

- **Un NaN en el estado hace desaparecer un objeto sin dejar rastro.** El
  servidor creaba las piezas sin asignarles giro; el cliente recibía un ángulo
  que no era un número, la matriz del objeto se llenaba de NaN, y three lo
  dibujaba dieciocho veces por segundo sin pintar un solo píxel. La malla estaba
  en la escena, visible, en su sitio y con su geometría: ninguna comprobación de
  posición lo detecta. Por eso la prueba de navegador ahora verifica que la
  matriz sean números, y `SceneObjects` no se fía de lo que llega.
- **Un rótulo transparente abre un agujero en el panel que tiene detrás.** Three
  ordena los transparentes por distancia, y con dos planos a cuatro milímetros
  ese orden lo decide el redondeo. Cuando salía primero el rótulo, escribía
  profundidad y el fondo del panel ya no pasaba el test: quedaba un rectángulo
  por el que se veía la sala. Nada de la interfaz escribe profundidad y el orden
  se fija a mano.
- **Añadir un mapa a un material ya creado no recompila su shader.** Las
  miniaturas del carrusel se quedaban en blanco para siempre. Se montan cuando
  la textura ya existe.
- **Contar peticiones en vez de fallos deja fuera a la clase entera.** Un salón
  comparte la IP del campus, y quien llega antes reintenta cada pocos segundos.
  El límite cuenta intentos fallidos; el PIN por fuerza bruta sigue tropezando.
- **`joinById` no significa que haya estado.** Resuelve al abrirse el WebSocket.
  Leer `room.state` antes de esperarlo tumba el árbol de React entero y deja una
  pantalla negra sin pistas. Por eso existe `firstState()`.
- **MediaPipe en un worker ESM necesita la variante de módulo** de su runtime
  (`forVisionTasks(path, true)`). Con la clásica falla con *ModuleFactory not
  set*.
- **El WASM de MediaPipe no puede vivir en el `public/` de Vite**, porque la
  librería lo carga con `import()` dinámico y Vite lo prohíbe. Lo sirve el
  servidor, que además es como queda en producción.
- **Un túnel HTTP no transporta el UDP de WebRTC.** La sala conecta, los avatares
  se mueven y nadie se oye. La voz va por fuera del túnel.
- **Sin `compression()` en el servidor**, la descarga inicial no cabe en su
  propio presupuesto.
- Los fallos del render 3D se ven como una pantalla negra y **ninguna prueba de
  servidor los detecta**. Para eso está `npm run test:navegador`.
