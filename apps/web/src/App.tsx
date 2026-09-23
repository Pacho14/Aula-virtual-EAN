import { useCallback, useEffect, useRef, useState } from "react";
import { InputLayer } from "./input/inputLayer";
import { joinSession, type Scene } from "./net/api";
import { connectToRoom, type RoomHandle } from "./net/room";
import { Voice } from "./net/voice";
import { Stage } from "./scene/Stage";
import type { HudSnapshot } from "./scene/LocalPlayer";
import { Hud } from "./ui/Hud";
import { JoinScreen, type InputMode } from "./ui/JoinScreen";

type Phase = "join" | "connecting" | "live";

const EMPTY_HUD: HudSnapshot = {
  gesture: "none",
  detectFps: 0,
  renderFps: 0,
  hovered: null,
  held: null,
  handRaised: false,
  source: "mouse",
};

export default function App() {
  const [phase, setPhase] = useState<Phase>("join");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Aviso dentro de la sala: algo se degradó pero la clase sigue. */
  const [notice, setNotice] = useState<string | null>(null);

  const [handle, setHandle] = useState<RoomHandle | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [playerIds, setPlayerIds] = useState<string[]>([]);
  const [objectIds, setObjectIds] = useState<string[]>([]);
  const [pin, setPin] = useState("");
  const [voiceOn, setVoiceOn] = useState(false);
  const [micOn, setMicOn] = useState(false);

  const inputRef = useRef(new InputLayer());
  const voiceRef = useRef<Voice | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HudSnapshot>(EMPTY_HUD);
  const [hud, setHud] = useState<HudSnapshot>(EMPTY_HUD);

  // El HUD se refresca a 5 Hz desde LocalPlayer; aqui solo se copia al estado
  // de React para pintarlo.
  const onHud = useCallback((snapshot: HudSnapshot) => {
    hudRef.current = snapshot;
    setHud(snapshot);
  }, []);

  const leave = useCallback(async () => {
    inputRef.current.stop();
    await voiceRef.current?.disconnect();
    voiceRef.current = null;
    handle?.dispose();
    setHandle(null);
    setScene(null);
    setPlayerIds([]);
    setObjectIds([]);
    setVoiceOn(false);
    setMicOn(false);
    setPhase("join");
  }, [handle]);

  async function join(
    enteredPin: string,
    alias: string,
    mode: InputMode,
    hostToken?: string,
  ) {
    setPhase("connecting");
    setError(null);
    try {
      setStatus("Validando el PIN...");
      const result = await joinSession(enteredPin, alias, hostToken);
      setScene(result.scene);
      setPin(enteredPin);

      setStatus("Entrando a la sala...");
      const connected = await connectToRoom(result.roomId, result.ticket, {
        onPlayers: setPlayerIds,
        onObjects: setObjectIds,
        onLeave: () => {
          setError("Se perdió la conexión con la sala.");
          setPhase("join");
        },
        onError: (message) => setError(message),
      });
      setHandle(connected);

      // La voz va por fuera del tunel (seccion 12). Si el servidor no la tiene
      // configurada, la sala funciona igual y se avisa en el HUD.
      if (result.voice) {
        setStatus("Conectando la voz...");
        try {
          const voice = new Voice();
          await voice.connect(result.voice.url, result.voice.token);
          voiceRef.current = voice;
          setVoiceOn(true);
          setMicOn(true);
        } catch (voiceProblem) {
          console.warn("[voz] no se pudo conectar:", voiceProblem);
          setVoiceOn(false);
        }
      }

      if (mode === "camera") {
        try {
          await inputRef.current.useCamera({ onStatus: setStatus, targetFps: 24 });
        } catch (cameraProblem) {
          // Que falle la camara no puede dejar a alguien fuera de la clase:
          // entra con el mouse y se le avisa. Es el modo de respaldo que pide
          // la seccion 10 del documento, funcionando de verdad.
          console.warn("[entrada] la camara no arranco:", cameraProblem);
          await inputRef.current.useMouse();
          setNotice(
            "No se pudo iniciar el seguimiento de manos. Entraste con mouse o toque.",
          );
        }
      } else {
        await inputRef.current.useMouse();
      }

      setStatus("");
      setPhase("live");
    } catch (problem) {
      console.error(problem);
      setError((problem as Error).message || "No se pudo entrar al salón.");
      setPhase("join");
    }
  }

  useEffect(() => {
    return () => {
      inputRef.current.stop();
      void voiceRef.current?.disconnect();
    };
  }, []);

  if (phase !== "live" || !handle || !scene) {
    return (
      <JoinScreen
        onJoin={join}
        busy={phase === "connecting"}
        status={status}
        error={error}
      />
    );
  }

  return (
    <div className="stage" ref={stageRef}>
      <Stage
        room={handle.room}
        sessionId={handle.sessionId}
        scene={scene}
        playerIds={playerIds}
        objectIds={objectIds}
        input={inputRef.current}
        voice={voiceRef.current}
        onHud={onHud}
      />
      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Cerrar aviso">
            ×
          </button>
        </div>
      )}
      <Hud
        snapshot={hud}
        pin={pin}
        participants={playerIds.length}
        micOn={micOn}
        voiceOn={voiceOn}
        onToggleMic={async () => {
          const next = !micOn;
          await voiceRef.current?.setMicrophone(next);
          setMicOn(next);
        }}
        onLeave={leave}
      />
    </div>
  );
}
