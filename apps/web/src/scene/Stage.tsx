import { Canvas } from "@react-three/fiber";
import { useRef } from "react";
import { NoToneMapping } from "three";
import type { InputLayer } from "../input/inputLayer";
import type { Scene } from "../net/api";
import type { AulaRoom } from "../net/room";
import type { Voice } from "../net/voice";
import { Avatars } from "./Avatars";
import { LocalPlayer, type HudSnapshot } from "./LocalPlayer";
import { SceneObjects } from "./SceneObjects";
import { WhiteRoom } from "./WhiteRoom";

export function Stage({
  room,
  sessionId,
  scene,
  playerIds,
  objectIds,
  input,
  voice,
  onHud,
}: {
  room: AulaRoom;
  sessionId: string;
  scene: Scene;
  playerIds: string[];
  objectIds: string[];
  input: InputLayer;
  voice: Voice | null;
  onHud: (snapshot: HudSnapshot) => void;
}) {
  const hoveredRef = useRef<string | null>(null);
  const mySpotId = room.state.players.get(sessionId)?.spotId ?? "";

  return (
    <Canvas
      // Presupuesto de la seccion 13: en celular de gama media el dpr alto es
      // lo primero que tumba los 30 fps.
      dpr={[1, 1.5]}
      gl={{
        antialias: true,
        powerPreference: "high-performance",
        // Sin esto R3F aplica ACES por defecto y la habitacion blanca se ve
        // gris sucia: justo lo que el entorno no debe ser.
        toneMapping: NoToneMapping,
      }}
      camera={{ fov: 62, near: 0.05, far: 60 }}
    >
      <color attach="background" args={["#EDF1F1"]} />

      <WhiteRoom
        halfSize={scene.bounds.halfSize}
        height={scene.bounds.height}
        spots={scene.spots}
        mySpotId={mySpotId}
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

      <LocalPlayer
        room={room}
        sessionId={sessionId}
        input={input}
        scene={scene}
        voice={voice}
        hoveredRef={hoveredRef}
        onHud={onHud}
      />
    </Canvas>
  );
}
