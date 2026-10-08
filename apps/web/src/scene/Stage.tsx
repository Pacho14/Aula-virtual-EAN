import { Canvas } from "@react-three/fiber";
import { useCallback, useRef, useState } from "react";
import { NoToneMapping } from "three";
import type { InputLayer } from "../input/inputLayer";
import type { Environment, Scene } from "../net/api";
import type { AulaRoom } from "../net/room";
import type { Voice } from "../net/voice";
import { Editor } from "../ui3d/Editor";
import { Avatars } from "./Avatars";
import { Environment360, type EnvStatus } from "./Environment360";
import { LocalPlayer, type HudSnapshot } from "./LocalPlayer";
import { SceneObjects } from "./SceneObjects";
import { WhiteRoom } from "./WhiteRoom";

/**
 * Gama baja: menos nucleos de los que tiene hasta un celular modesto de hoy.
 * Ahi el dpr alto y el antialiasing son lo primero que tumba los 30 fps, y
 * ninguno de los dos se nota tanto como el framerate en una pantalla chica.
 */
const LOW_END = typeof navigator !== "undefined" && navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4;

export function Stage({
  room,
  sessionId,
  scene,
  playerIds,
  objectIds,
  envId,
  editing,
  catalog,
  input,
  voice,
  onHud,
}: {
  room: AulaRoom;
  sessionId: string;
  scene: Scene;
  playerIds: string[];
  objectIds: string[];
  /** Entorno 360 en uso. "" es la habitación en blanco. */
  envId: string;
  /** Cierto solo para el profesor y solo mientras arma la escena. */
  editing: boolean;
  catalog: Environment[];
  input: InputLayer;
  voice: Voice | null;
  onHud: (snapshot: HudSnapshot) => void;
}) {
  const hoveredRef = useRef<string | null>(null);
  const mySpotId = room.state.players.get(sessionId)?.spotId ?? "";
  const [envStatus, setEnvStatus] = useState<EnvStatus>({ state: "idle" });

  // Se pasa por referencia estable: el efecto que carga la HDRI depende de
  // esta función, y una nueva en cada render la volvería a descargar.
  const onEnvStatus = useCallback((status: EnvStatus) => setEnvStatus(status), []);

  return (
    <Canvas
      // Presupuesto de la seccion 13: en celular de gama media el dpr alto es
      // lo primero que tumba los 30 fps.
      dpr={LOW_END ? [1, 1] : [1, 1.5]}
      gl={{
        antialias: !LOW_END,
        powerPreference: "high-performance",
        // Sin entorno 360 no hay mapeo de tonos: con ACES por defecto la
        // habitacion blanca se ve gris sucia, justo lo que no debe ser. Al
        // elegir un entorno, Environment360 lo enciende.
        toneMapping: NoToneMapping,
      }}
      camera={{ fov: 62, near: 0.05, far: 60 }}
    >
      <color attach="background" args={["#EDF1F1"]} />

      <Environment360
        room={room}
        envId={envId}
        catalog={catalog}
        onStatus={onEnvStatus}
      />

      <WhiteRoom
        halfSize={scene.bounds.halfSize}
        spots={scene.spots}
        mySpotId={mySpotId}
        placement={scene.placement.floor}
        showPlacement={editing}
        lit={envId === ""}
      />

      <SceneObjects
        room={room}
        ids={objectIds}
        sessionId={sessionId}
        hoveredRef={hoveredRef}
      />

      <Avatars
        room={room}
        ids={playerIds}
        sessionId={sessionId}
        onHeadPosition={(voiceId, x, y, z) => voice?.setSpeakerPosition(voiceId, x, y, z)}
      />

      {editing && (
        <Editor
          room={room}
          sessionId={sessionId}
          scene={scene}
          catalog={catalog}
          envStatus={envStatus}
          objectIds={objectIds}
        />
      )}

      <LocalPlayer
        room={room}
        sessionId={sessionId}
        input={input}
        scene={scene}
        voice={voice}
        editing={editing}
        hoveredRef={hoveredRef}
        onHud={onHud}
      />
    </Canvas>
  );
}
