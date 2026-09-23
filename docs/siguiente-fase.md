# Dónde quedamos

Última sesión: **23 de septiembre de 2026**. La fase 1 está construida y
funcionando de extremo a extremo en desarrollo. Lo que falta para darla por
cerrada no es código: son mediciones en equipos reales.

## Para retomar

```bash
npm install          # repone node_modules y el runtime de MediaPipe
npm run dev
```

Abre <http://localhost:5173>. El código de profesor está en el `.env` local
(`TEACHER_CODE`). Si clonaste el repo, copia `.env.example` a `.env` y pon uno:
sin eso el servidor genera uno al arrancar y lo imprime en la consola.

Antes de tocar nada, corre las tres pruebas para confirmar que sigues en verde:

```bash
npm run smoke -w @aula/server        # poses, agarres, autoridad del servidor
npm run test:acceso -w @aula/server  # acceso de profesor y vida del salón
npm run test:navegador               # la app en un Chrome real, con capturas
```

## Lo que ya funciona y está verificado

- Habitación blanca con tres assets, agarrar y mover, servidor autoritativo.
- Solo el profesor crea salones; el rol se demuestra con `hostToken`, no se pide.
- El salón sobrevive vacío y se recoge a los 45 minutos.
- Detección de manos por cámara en un Web Worker, con filtro One Euro.
- Avatares de medio cuerpo con nombre, e interpolación en el receptor.
- Túnel de Cloudflare transportando app, API y el WebSocket de Colyseus.

## Lo que falta para cerrar la fase 1

El criterio es *30 fps en celular de gama media y gestos usables sin
instrucciones largas*. Eso no se puede verificar desde esta máquina. Hay que
salir a medir, con los teléfonos que realmente tienen los estudiantes:

1. ¿Se sostienen los 30 fps con 6 participantes? El HUD muestra fps de render y
   de detección en vivo.
2. ¿Cuánto tarda alguien que nunca lo ha visto en agarrar y mover la válvula?
3. ¿Aguanta la detección con luz de techo y con contraluz?
4. ¿A los cuántos minutos se cansa el brazo?

Queda también una pieza de infraestructura sin probar: **la voz**. El código
está completo pero nadie lo ha oído funcionar, porque hace falta una cuenta de
LiveKit Cloud (plan gratuito) y poner las tres variables en el `.env`. Hasta
entonces la sala funciona muda y lo dice en el HUD.

## Lo que sigue: fase 2 (MVP)

Por orden de dependencia, no de dificultad:

1. **Quest 3.** La capa de entrada ya define dónde enchufar WebXR Hand Input;
   es una fuente más junto a la cámara y el mouse.
2. **Persistencia.** Redis para el mapa de PIN y Supabase para salones, escenas
   y eventos. La interfaz de `tickets.ts` está pensada para que no cambie.
3. **Editor de salones.** Ubicar assets en vista 2D y 3D, definir puntos de
   estudiante, publicar y congelar una versión de la escena.
4. **Subida de assets.** GLB hasta 75 MB, con el pipeline de optimización y la
   barra de presupuesto que bloquea publicar si la escena se pasa de peso.
5. **Tareas y retroalimentación.** Colocar, seleccionar y secuencia, con el
   panel en vivo del profesor y el resumen al cerrar.
6. **Autenticación de profesor.** Sustituye el `TEACHER_CODE` del `.env`.

El documento de arquitectura tiene el detalle de cada una.

## Cosas que aprendimos construyendo, y conviene no olvidar

- **`joinById` no significa que haya estado.** Resuelve al abrirse el
  WebSocket. Leer `room.state` antes de esperarlo tumba el árbol de React
  entero y deja una pantalla negra sin pistas. Por eso existe `firstState()`.
- **MediaPipe en un worker ESM necesita la variante de módulo** de su runtime
  (`forVisionTasks(path, true)`). Con la clásica falla con *ModuleFactory not
  set*.
- **El WASM de MediaPipe no puede vivir en el `public/` de Vite**, porque la
  librería lo carga con `import()` dinámico y Vite lo prohíbe. Lo sirve el
  servidor, que además es como queda en producción.
- **Un túnel HTTP no transporta el UDP de WebRTC.** La sala conecta, los
  avatares se mueven y nadie se oye. La voz va por fuera del túnel.
- **Sin `compression()` en el servidor**, la fase 1 no cabe en su propio
  presupuesto de descarga.
- Los fallos del render 3D se ven como una pantalla negra y **ninguna prueba de
  servidor los detecta**. Para eso está `npm run test:navegador`.
