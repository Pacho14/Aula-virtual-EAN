/**
 * El editor de escena del profesor.
 *
 * Todo lo que hay aquí vive dentro de la escena 3D y se opera con las manos:
 * no hay un solo control en el DOM. Son cinco paneles anclados alrededor del
 * puesto del profesor -no pegados a su cabeza, que es lo que marea-, y la
 * cámara sigue la mano para que lleguen a estar a la vista cuando se estira
 * hacia ellos.
 *
 *   izquierda arriba   carrusel de entornos 360
 *   izquierda abajo    ubicar el entorno: girar y subir o bajar
 *   derecha arriba     objetos: esfera, cilindro y cubo
 *   derecha abajo      revisar y comenzar
 *   centro abajo       los dos deslizadores de giro del entorno
 *
 * Nada de esto lo ve un estudiante: la fase de edición termina antes de que
 * exista el primero.
 */
import { useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LinearFilter, SRGBColorSpace, TextureLoader, type Group, type Texture } from "three";
import { assetUrl, type Environment, type Scene } from "../net/api";
import type { AulaRoom } from "../net/room";
import { autoGrab, envPredicted } from "../scene/registry";
import type { EnvStatus } from "../scene/Environment360";
import { Button3D, Panel, Slider3D } from "./parts";
import { INK, label, makeSheet, paint, panelBackground, UI_ORDER } from "./surface";
import { clearWidgets } from "./widgets";

/** Recorrido de los dos deslizadores: 180 grados, de -90 a +90. */
const HALF_TURN = Math.PI / 2;
/** Cuánto giran y suben los botones de ubicación en cada pulsación. */
const NUDGE_ANGLE = (5 * Math.PI) / 180;
const NUDGE_HEIGHT = 0.05;

/**
 * Donde se cuelgan los paneles alrededor del profesor.
 *
 * A metro y medio y con estas medidas cada panel ocupa unos 25 grados: se lee
 * sin esfuerzo y deja el centro libre para ver la mesa, que es donde pasa
 * todo. Mas cerca, o mas grandes, y el menu tapa el salon que se esta armando.
 *
 * La apertura lateral es de unos 27 grados. Con el telefono apoyado en
 * horizontal eso los deja dentro del cuadro en reposo, y la camara siguiendo
 * la mano acaba de centrarlos cuando el profesor se estira hacia ellos.
 */
const REACH = 1.62;
const SIDE = 0.48;

export function Editor({
  room,
  sessionId,
  scene,
  catalog,
  envStatus,
  objectIds,
}: {
  room: AulaRoom;
  sessionId: string;
  scene: Scene;
  catalog: Environment[];
  envStatus: EnvStatus;
  objectIds: string[];
}) {
  const [index, setIndex] = useState(0);
  const [preview, setPreview] = useState(false);

  // --- dónde va cada panel ------------------------------------------------
  const places = useMemo(() => {
    const me = room.state.players.get(sessionId);
    const spot = scene.spots.find((s) => s.id === me?.spotId) ?? scene.spots[0]!;
    const eye: [number, number, number] = [spot.pos[0], 1.6, spot.pos[2]];
    const yaw = aimYaw(eye, scene.focus);
    return {
      carousel: anchor(eye, yaw, -SIDE, REACH, 0.1),
      envPlace: anchor(eye, yaw, -SIDE, REACH, -0.38),
      palette: anchor(eye, yaw, SIDE, REACH, 0.12),
      review: anchor(eye, yaw, SIDE, REACH, -0.4),
      // Bien abajo: unos centímetros más arriba y el panel se planta justo
      // sobre el tablero, que es donde el profesor tiene que ver lo que pone.
      sliders: anchor(eye, yaw, 0, 1.45, -0.87),
      preview: anchor(eye, yaw, 0, 1.45, 0.02),
    };
  }, [room, scene, sessionId]);

  // --- envío del entorno, con predicción local ----------------------------
  //
  // El deslizador tiene que responder en el cuadro, no en el siguiente tick
  // del servidor. Se mueve el paisaje aquí mismo y se manda lo último que hay
  // veinte veces por segundo, que es el ritmo al que la sala habla.
  const pending = useRef<Record<string, number | string> | null>(null);
  const sentAt = useRef(0);

  const pushEnv = useCallback((patch: Record<string, number | string>) => {
    pending.current = { ...(pending.current ?? {}), ...patch };
    if (typeof patch.yaw === "number") envPredicted.yaw = patch.yaw;
    if (typeof patch.pitch === "number") envPredicted.pitch = patch.pitch;
    if (typeof patch.height === "number") envPredicted.height = patch.height;
  }, []);

  useFrame(() => {
    const now = performance.now();
    if (pending.current && now - sentAt.current >= 50) {
      sentAt.current = now;
      room.send("env", pending.current);
      pending.current = null;
    }
  });

  // Al salir del editor la predicción se apaga: de ahí en adelante manda el
  // estado de la sala, que es lo que ven todos los demás.
  useEffect(() => {
    envPredicted.yaw = room.state.envYaw;
    envPredicted.pitch = room.state.envPitch;
    envPredicted.height = room.state.envHeight;
    return () => {
      envPredicted.yaw = null;
      envPredicted.pitch = null;
      envPredicted.height = null;
    };
  }, [room]);

  // El servidor confirma con qué id nació la pieza. Se avisa a la escena, que
  // la engancha a la mano en el mismo cuadro: elegirla y llevarla son un solo
  // movimiento, no dos.
  useEffect(() => {
    const off = room.onMessage("spawned", (message: { id?: string }) => {
      if (!message?.id) return;
      autoGrab.id = message.id;
      autoGrab.since = performance.now();
    });
    return () => {
      off?.();
      autoGrab.id = null;
    };
  }, [room]);

  // Al cerrar el editor no puede quedar ni un control registrado: el rayo del
  // puntero seguiría chocando contra paneles que ya nadie dibuja.
  useEffect(() => clearWidgets, []);

  const readYaw = useCallback(() => envPredicted.yaw ?? room.state.envYaw, [room]);
  const readPitch = useCallback(() => envPredicted.pitch ?? room.state.envPitch, [room]);
  const readHeight = useCallback(() => envPredicted.height ?? room.state.envHeight, [room]);

  // --- piezas puestas -----------------------------------------------------
  const pieces = objectIds.filter((id) => !room.state.objects.get(id)?.locked);
  const current = catalog[index];
  const applied = room.state.envId;

  if (preview) {
    return (
      <group position={places.preview.position} rotation={places.preview.rotation}>
        <PreviewPanel
          scene={scene}
          pin={room.state.pin}
          envLabel={catalog.find((e) => e.id === applied)?.label ?? "Habitación en blanco"}
          pieces={pieces.map((id) => room.state.objects.get(id)?.label ?? "Pieza")}
          onBack={() => setPreview(false)}
          onStart={() => room.send("publish")}
        />
      </group>
    );
  }

  return (
    <group>
      {/* --- carrusel de entornos 360 --- */}
      <group position={places.carousel.position} rotation={places.carousel.rotation}>
        <Panel width={0.78} height={0.54} title="Entorno 360">
          <Carousel catalog={catalog} index={index} applied={applied} status={envStatus} />
          <Button3D
            id="env-prev"
            position={[-0.29, -0.18, 0.004]}
            width={0.11}
            height={0.1}
            text="◀"
            disabled={catalog.length < 2}
            onActivate={() => setIndex((i) => (i - 1 + catalog.length) % catalog.length)}
          />
          <Button3D
            id="env-apply"
            position={[0, -0.18, 0.004]}
            width={0.38}
            height={0.1}
            tone="primary"
            text={current && current.id === applied ? "Puesto" : "Usar este"}
            disabled={!current || current.id === applied}
            onActivate={() => current && pushEnv({ id: current.id })}
          />
          <Button3D
            id="env-next"
            position={[0.29, -0.18, 0.004]}
            width={0.11}
            height={0.1}
            text="▶"
            disabled={catalog.length < 2}
            onActivate={() => setIndex((i) => (i + 1) % catalog.length)}
          />
        </Panel>
      </group>

      {/* --- ubicar el entorno en el espacio --- */}
      <group position={places.envPlace.position} rotation={places.envPlace.rotation}>
        <Panel width={0.54} height={0.32} title="Ubicar el entorno">
          <Nudge
            y={0.02}
            text="Girar"
            idLess="env-yaw-less"
            idMore="env-yaw-more"
            onLess={() => pushEnv({ yaw: clamp(readYaw() - NUDGE_ANGLE, -HALF_TURN, HALF_TURN) })}
            onMore={() => pushEnv({ yaw: clamp(readYaw() + NUDGE_ANGLE, -HALF_TURN, HALF_TURN) })}
          />
          <Nudge
            y={-0.09}
            text="Altura"
            idLess="env-down"
            idMore="env-up"
            less="▼"
            more="▲"
            onLess={() => pushEnv({ height: clamp(readHeight() - NUDGE_HEIGHT, -1.5, 1.5) })}
            onMore={() => pushEnv({ height: clamp(readHeight() + NUDGE_HEIGHT, -1.5, 1.5) })}
          />
        </Panel>
      </group>

      {/* --- panel de objetos --- */}
      <group position={places.palette.position} rotation={places.palette.rotation}>
        <Panel width={0.56} height={0.62} title="Objetos">
          <Button3D
            id="add-sphere"
            position={[0, 0.13, 0.004]}
            width={0.44}
            height={0.11}
            text="Esfera"
            glyph="sphere"
            onActivate={() => room.send("spawn", { prim: "sphere" })}
          />
          <Button3D
            id="add-cylinder"
            position={[0, 0.005, 0.004]}
            width={0.44}
            height={0.11}
            text="Cilindro"
            glyph="cylinder"
            onActivate={() => room.send("spawn", { prim: "cylinder" })}
          />
          <Button3D
            id="add-box"
            position={[0, -0.12, 0.004]}
            width={0.44}
            height={0.11}
            text="Cubo"
            glyph="box"
            onActivate={() => room.send("spawn", { prim: "box" })}
          />
          <Button3D
            id="remove-last"
            position={[0, -0.25, 0.004]}
            width={0.44}
            height={0.095}
            text={pieces.length ? `Quitar la última (${pieces.length})` : "No hay piezas"}
            disabled={pieces.length === 0}
            onActivate={() => {
              const last = pieces[pieces.length - 1];
              if (last) room.send("remove", { id: last });
            }}
          />
        </Panel>
      </group>

      {/* --- revisar y comenzar --- */}
      <group position={places.review.position} rotation={places.review.rotation}>
        <Panel width={0.56} height={0.22}>
          <Button3D
            id="open-preview"
            position={[0, 0, 0.004]}
            width={0.46}
            height={0.13}
            tone="primary"
            text="Revisar y comenzar"
            onActivate={() => setPreview(true)}
          />
        </Panel>
      </group>

      {/* --- los dos deslizadores de giro --- */}
      <group position={places.sliders.position} rotation={places.sliders.rotation}>
        <Panel width={0.82} height={0.32} title="Explorar el escenario">
          <Slider3D
            id="slider-yaw"
            position={[0, -0.01, 0.006]}
            length={0.66}
            text="Girar horizontal"
            min={-HALF_TURN}
            max={HALF_TURN}
            value={readYaw}
            format={degrees}
            onChange={(value) => pushEnv({ yaw: value })}
          />
          <Slider3D
            id="slider-pitch"
            position={[0, -0.12, 0.006]}
            length={0.66}
            text="Girar vertical"
            min={-HALF_TURN}
            max={HALF_TURN}
            value={readPitch}
            format={degrees}
            onChange={(value) => pushEnv({ pitch: value })}
          />
        </Panel>
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// El carrusel
// ---------------------------------------------------------------------------

const THUMB_W = 0.3;
const THUMB_H = 0.15;
const STEP = 0.25;

/**
 * La tira de miniaturas.
 *
 * Se desliza en vez de cambiar de golpe porque el movimiento es lo que dice
 * que hay más entornos a los lados; con un cambio seco, el profesor no sabe
 * si acaba de avanzar o de cargar otra cosa. Solo bajan las miniaturas -unos
 * 60 KB cada una-; la HDRI completa espera a que se elija.
 */
function Carousel({
  catalog,
  index,
  applied,
  status,
}: {
  catalog: Environment[];
  index: number;
  applied: string;
  status: EnvStatus;
}) {
  const strip = useRef<Group>(null);
  const [textures, setTextures] = useState<Map<string, Texture>>(new Map());

  useEffect(() => {
    const loader = new TextureLoader();
    let cancelled = false;
    const loaded = new Map<string, Texture>();

    Promise.all(
      catalog.map(
        (environment) =>
          new Promise<void>((resolve) => {
            loader.load(
              assetUrl(environment.thumb),
              (texture) => {
                texture.colorSpace = SRGBColorSpace;
                texture.minFilter = LinearFilter;
                loaded.set(environment.id, texture);
                resolve();
              },
              undefined,
              () => resolve(),
            );
          }),
      ),
    ).then(() => {
      if (cancelled) loaded.forEach((texture) => texture.dispose());
      else setTextures(loaded);
    });

    return () => {
      cancelled = true;
    };
  }, [catalog]);

  useFrame((_, delta) => {
    const group = strip.current;
    if (!group) return;
    const target = -index * STEP;
    group.position.x += (target - group.position.x) * (1 - Math.exp(-11 * delta));
    for (const child of group.children) {
      const distance = Math.abs(child.position.x + group.position.x);
      const near = Math.max(0, 1 - distance / STEP);
      const scale = 0.55 + near * 0.45;
      child.scale.setScalar(child.scale.x + (scale - child.scale.x) * (1 - Math.exp(-11 * delta)));
      // Solo la actual y sus dos vecinas caben en el panel. La tercera se
      // saldría por el borde y quedaría flotando sobre la sala.
      child.visible = distance < STEP * 1.6;
    }
  });

  const currentEnv = catalog[index];
  const caption = useMemo(() => makeSheet(0.68, 0.07), []);
  useEffect(() => {
    const loading = status.state === "loading" ? Math.round(status.progress * 100) : null;
    const text = !currentEnv
      ? "No hay entornos preparados"
      : loading !== null && status.state === "loading" && status.id === currentEnv.id
        ? `Descargando… ${loading}%`
        : currentEnv.id === applied
          ? `${currentEnv.label} · en uso`
          : currentEnv.label;
    paint(caption, (ctx, w, h) => {
      label(ctx, text, w / 2, h / 2, {
        size: 26,
        align: "center",
        color: currentEnv && currentEnv.id === applied ? INK.accent : INK.text,
      });
    });
  }, [applied, caption, currentEnv, status]);

  return (
    <group>
      {/*
        La tira no se dibuja hasta que estan las miniaturas. No es por estetica:
        anadirle un mapa a un material que se creo sin el no recompila su
        shader, asi que los planos se quedaban blancos para siempre. Montarlos
        cuando la textura ya existe evita el problema de raiz.
      */}
      <group ref={strip} position={[0, 0.05, 0.003]}>
        {textures.size > 0 &&
          catalog.map((environment, i) => (
            <mesh
              key={environment.id}
              position={[i * STEP, 0, 0]}
              renderOrder={UI_ORDER.art}
              raycast={() => null}
            >
              <planeGeometry args={[THUMB_W, THUMB_H]} />
              <meshBasicMaterial
                map={textures.get(environment.id) ?? null}
                transparent
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
          ))}
      </group>
      <mesh position={[0, -0.075, 0.004]} renderOrder={UI_ORDER.text} raycast={() => null}>
        <planeGeometry args={[0.68, 0.07]} />
        <meshBasicMaterial map={caption.texture} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      {status.state === "loading" && (
        <mesh
          position={[-0.34 + (0.68 * status.progress) / 2, -0.115, 0.004]}
          renderOrder={UI_ORDER.mark}
          raycast={() => null}
        >
          <planeGeometry args={[Math.max(0.004, 0.68 * status.progress), 0.008]} />
          <meshBasicMaterial color={INK.accent} transparent depthWrite={false} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Piezas menores
// ---------------------------------------------------------------------------

/** Una fila de "menos / etiqueta / más". */
function Nudge({
  y,
  text,
  idLess,
  idMore,
  less = "◀",
  more = "▶",
  onLess,
  onMore,
}: {
  y: number;
  text: string;
  idLess: string;
  idMore: string;
  less?: string;
  more?: string;
  onLess: () => void;
  onMore: () => void;
}) {
  const sheet = useMemo(() => makeSheet(0.22, 0.08), []);
  useEffect(() => {
    paint(sheet, (ctx, w, h) => {
      label(ctx, text, w / 2, h / 2, { size: 24, align: "center", color: INK.dim });
    });
  }, [sheet, text]);

  return (
    <group position={[0, y, 0]}>
      <Button3D
        id={idLess}
        position={[-0.17, 0, 0.004]}
        width={0.1}
        height={0.09}
        text={less}
        onActivate={onLess}
      />
      <mesh position={[0, 0, 0.004]} renderOrder={UI_ORDER.text} raycast={() => null}>
        <planeGeometry args={[0.22, 0.08]} />
        <meshBasicMaterial map={sheet.texture} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <Button3D
        id={idMore}
        position={[0.17, 0, 0.004]}
        width={0.1}
        height={0.09}
        text={more}
        onActivate={onMore}
      />
    </group>
  );
}

/**
 * La vista previa antes de abrir el salón.
 *
 * Es el mismo resumen del panel de entrada de la fase 1 -nombre, PIN, cuánta
 * gente- pero dentro de la escena, porque quien lo lee ya tiene la cámara
 * puesta y las manos en el aire: mandarlo de vuelta al navegador para
 * confirmar sería sacarlo del salón que acaba de armar.
 */
function PreviewPanel({
  scene,
  pin,
  envLabel,
  pieces,
  onBack,
  onStart,
}: {
  scene: Scene;
  pin: string;
  envLabel: string;
  pieces: string[];
  onBack: () => void;
  onStart: () => void;
}) {
  const sheet = useMemo(() => makeSheet(1.3, 0.84), []);

  useEffect(() => {
    paint(sheet, (ctx, w, h) => {
      panelBackground(ctx, w, h);

      label(ctx, "ASÍ QUEDA EL SALÓN", w / 2, 50, {
        size: 24,
        color: INK.dim,
        align: "center",
        weight: 700,
      });
      label(ctx, scene.roomName, w / 2, 104, { size: 46, align: "center", weight: 700 });

      const left = 70;
      const right = w / 2 + 30;
      let y = 190;

      label(ctx, "PIN", left, y, { size: 24, color: INK.dim });
      label(ctx, pin || "—", left + 120, y, { size: 40, color: INK.accent, weight: 700 });
      y += 62;
      label(ctx, "Estudiantes", left, y, { size: 24, color: INK.dim });
      label(ctx, String(scene.students), left + 220, y, { size: 30 });
      y += 52;
      label(ctx, "Cupo total", left, y, { size: 24, color: INK.dim });
      label(ctx, String(scene.capacity), left + 220, y, { size: 30 });
      y += 52;
      label(ctx, "Entorno", left, y, { size: 24, color: INK.dim });
      label(ctx, envLabel, left + 220, y, { size: 26 });

      label(ctx, `PIEZAS SOBRE LA MESA · ${pieces.length}`, right, 190, {
        size: 22,
        color: INK.dim,
        weight: 700,
      });
      if (pieces.length === 0) {
        label(ctx, "Ninguna todavía", right, 240, { size: 26, color: INK.warn });
      } else {
        const counted = new Map<string, number>();
        for (const piece of pieces) counted.set(piece, (counted.get(piece) ?? 0) + 1);
        let row = 240;
        for (const [name, count] of counted) {
          label(ctx, `${count} × ${name}`, right, row, { size: 26 });
          row += 40;
        }
      }
    });
  }, [envLabel, pieces, pin, scene, sheet]);

  return (
    <group>
      <mesh renderOrder={UI_ORDER.panel}>
        <planeGeometry args={[1.3, 0.84]} />
        <meshBasicMaterial map={sheet.texture} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <Button3D
        id="preview-back"
        position={[-0.32, -0.29, 0.004]}
        width={0.42}
        height={0.13}
        text="Seguir armando"
        onActivate={onBack}
      />
      <Button3D
        id="preview-start"
        position={[0.32, -0.29, 0.004]}
        width={0.42}
        height={0.13}
        tone="primary"
        text="Comenzar la sesión"
        onActivate={onStart}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------

/**
 * Sitio y orientación de un panel alrededor del puesto del profesor.
 *
 * `angle` abre hacia la derecha en positivo. El panel queda mirando al ojo,
 * también en vertical: uno colgado a la altura de la frente y plano se lee
 * torcido, y con la cámara siguiendo la mano se nota todavía más.
 */
function anchor(
  eye: readonly [number, number, number],
  yaw: number,
  angle: number,
  distance: number,
  dy: number,
) {
  const a = yaw - angle;
  const position: [number, number, number] = [
    eye[0] - Math.sin(a) * distance,
    eye[1] + dy,
    eye[2] - Math.cos(a) * distance,
  ];
  const pitch = Math.atan2(-dy, distance);
  return { position, rotation: [pitch, a, 0, "YXZ"] as [number, number, number, "YXZ"] };
}

/** El yaw con el que la cámara del profesor arranca mirando a la mesa. */
function aimYaw(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
) {
  return Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
}

function degrees(radians: number) {
  return `${Math.round((radians * 180) / Math.PI)}°`;
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}
