import { useCallback, useEffect, useRef, useState } from "react";
import { InputLayer } from "./input/inputLayer";
import {
  fetchEnvironments,
  fetchLobby,
  joinSession,
  RoomNotReady,
  type Environment,
  type SalonView,
  type Scene,
} from "./net/api";
import { connectToRoom, type RoomHandle } from "./net/room";
import { Voice } from "./net/voice";
import { LobbyStage } from "./scene/LobbyStage";
import { Stage } from "./scene/Stage";
import type { HudSnapshot } from "./scene/LocalPlayer";
import { CameraControls } from "./ui/CameraControls";
import { Hud } from "./ui/Hud";
import { JoinScreen, type InputMode } from "./ui/JoinScreen";
import { LandmarkOverlay } from "./ui/LandmarkOverlay";

/**
 * Por dónde va la sesión.
 *
 *   join        la pantalla de entrada
 *   lobby       el estudiante entre los portales, sin código todavía
 *   connecting  validando el código y abriendo la sala
 *   live        dentro de la clase
 */
type Phase = "join" | "lobby" | "connecting" | "live";

/** Quién es quien está usando la aplicación. */
interface Identity {
  role: "teacher" | "student";
  email: string;
  displayName: string;
}

/** Cada cuánto el lobby vuelve a preguntar por los tres salones. */
const LOBBY_REFRESH_MS = 4000;

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

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [mode, setMode] = useState<InputMode>("camera");
  const [showLandmarks, setShowLandmarks] = useState(false);

  const [handle, setHandle] = useState<RoomHandle | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [playerIds, setPlayerIds] = useState<string[]>([]);
  const [objectIds, setObjectIds] = useState<string[]>([]);
  const [pin, setPin] = useState("");
  const [voiceOn, setVoiceOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [roomPhase, setRoomPhase] = useState<"editing" | "live">("live");
  const [envId, setEnvId] = useState("");
  const [catalog, setCatalog] = useState<Environment[]>([]);

  // --- lobby ---------------------------------------------------------------
  const [salones, setSalones] = useState<SalonView[]>([]);
  const [openSalon, setOpenSalon] = useState<number | null>(null);
  /**
   * Cuadros por segundo del detector de manos, mientras se está en el lobby.
   *
   * Se ve antes de entrar a clase a propósito: si la cámara no arrancó o la
   * luz no da, es mejor enterarse en el pasillo que delante de todos.
   */
  const [detectFps, setDetectFps] = useState(0);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);

  const inputRef = useRef(new InputLayer());
  const voiceRef = useRef<Voice | null>(null);
  const hudRef = useRef<HudSnapshot>(EMPTY_HUD);
  const [hud, setHud] = useState<HudSnapshot>(EMPTY_HUD);

  // El catálogo son tres líneas de JSON: se pide al abrir la aplicación para
  // que el carrusel del profesor no tenga que esperarlo dentro de la sala.
  useEffect(() => {
    fetchEnvironments()
      .then(setCatalog)
      .catch((problem) => console.warn("[entornos] catálogo no disponible:", problem));
  }, []);

  // El estado de los tres salones se refresca solo mientras se está en el
  // lobby: es lo que hace que la tabla y los portales cambien cuando un
  // profesor abre una clase al otro lado.
  useEffect(() => {
    if (phase !== "lobby") return;
    let vivo = true;

    const pedir = () => {
      fetchLobby()
        .then((lista) => {
          if (vivo) setSalones(lista);
        })
        .catch((problem) => console.warn("[lobby] no se pudo refrescar:", problem));
    };

    pedir();
    const timer = setInterval(pedir, LOBBY_REFRESH_MS);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== "lobby" && phase !== "connecting") return;
    const timer = setInterval(() => setDetectFps(inputRef.current.peek().detectFps), 500);
    return () => clearInterval(timer);
  }, [phase]);

  // El HUD se refresca a 5 Hz desde LocalPlayer; aqui solo se copia al estado
  // de React para pintarlo.
  const onHud = useCallback((snapshot: HudSnapshot) => {
    hudRef.current = snapshot;
    setHud(snapshot);
  }, []);

  /** Arranca la cámara o el mouse. Si la cámara falla, se entra con mouse. */
  const startInput = useCallback(async (wanted: InputMode) => {
    if (wanted === "mouse") {
      await inputRef.current.useMouse();
      return null;
    }
    try {
      await inputRef.current.useCamera({ onStatus: setStatus, targetFps: 24 });
      return null;
    } catch (problem) {
      // Que falle la cámara no puede dejar a nadie fuera: se entra con mouse y
      // se avisa. Es el modo de respaldo que pide la sección 10 del documento.
      console.warn("[entrada] la cámara no arrancó:", problem);
      await inputRef.current.useMouse();
      return "No se pudo iniciar el seguimiento de manos. Entraste con mouse o toque.";
    }
  }, []);

  const leave = useCallback(async () => {
    await voiceRef.current?.disconnect();
    voiceRef.current = null;
    handle?.dispose();
    setHandle(null);
    setScene(null);
    setPlayerIds([]);
    setObjectIds([]);
    setVoiceOn(false);
    setMicOn(false);
    setEnvId("");
    setRoomPhase("live");
    setCode("");
    setCodeError(null);
    setOpenSalon(null);

    // El estudiante vuelve al lobby, no a la pantalla de entrada: ya se
    // identificó y su clase puede no ser la única del día.
    if (identity?.role === "student") {
      setPhase("lobby");
      return;
    }
    inputRef.current.stop();
    setIdentity(null);
    setPhase("join");
  }, [handle, identity]);

  // --- entrada del estudiante al lobby -------------------------------------
  async function enterLobby(
    who: { email: string; displayName: string },
    wanted: InputMode,
  ) {
    setError(null);
    setMode(wanted);
    setIdentity({ role: "student", ...who });
    const aviso = await startInput(wanted);
    if (aviso) setNotice(aviso);
    setStatus("");
    setPhase("lobby");
  }

  // --- entrada a una sala ---------------------------------------------------
  async function enterRoom(options: {
    pin: string;
    alias: string;
    hostToken?: string;
    salon?: number;
    /** El profesor arranca su entrada desde la pantalla, no desde el lobby. */
    startInputAs?: InputMode;
  }) {
    setError(null);
    setCodeError(null);
    setPhase("connecting");

    try {
      setStatus("Validando el código...");
      let result = null as Awaited<ReturnType<typeof joinSession>> | null;
      for (;;) {
        try {
          result = await joinSession(options);
          break;
        } catch (problem) {
          // Un salón que todavía se está armando no es un error: se espera y
          // se reintenta solo.
          if (!(problem instanceof RoomNotReady)) throw problem;
          setStatus(
            problem.roomName
              ? `${problem.roomName}: el profesor está preparando la sala...`
              : "El profesor está preparando la sala...",
          );
          await wait(4000);
        }
      }

      setScene(result.scene);
      setPin(options.pin);
      setIdentity((before) =>
        before
          ? { ...before, role: result.role }
          : { role: result.role, email: "", displayName: options.alias },
      );

      if (options.startInputAs) {
        setMode(options.startInputAs);
        const aviso = await startInput(options.startInputAs);
        if (aviso) setNotice(aviso);
      }

      setStatus("Entrando a la sala...");
      const connected = await connectToRoom(result.roomId, result.ticket, {
        onPlayers: setPlayerIds,
        onObjects: setObjectIds,
        onEnvironment: setEnvId,
        onPhase: setRoomPhase,
        onLeave: () => {
          setError("Se perdió la conexión con la sala.");
          setPhase(identity?.role === "student" ? "lobby" : "join");
        },
        onError: (message) => setError(message),
      });
      setHandle(connected);
      setRoomPhase(connected.room.state.phase);
      setEnvId(connected.room.state.envId);

      // La voz va por fuera del túnel (sección 12). Si el servidor no la tiene
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

      setStatus("");
      setPhase("live");
    } catch (problem) {
      console.error(problem);
      const message = (problem as Error).message || "No se pudo entrar a la sala.";
      if (options.salon) {
        // Desde el lobby el error se muestra en el teclado, junto al código
        // que se acaba de escribir, no en una pantalla aparte.
        setCodeError(message);
        setCode("");
        setPhase("lobby");
      } else {
        setError(message);
        setPhase("join");
      }
    }
  }

  useEffect(() => {
    return () => {
      inputRef.current.stop();
      void voiceRef.current?.disconnect();
    };
  }, []);

  const handTracking = mode === "camera";
  const salonAbierto = salones.find((s) => s.salon === openSalon) ?? null;

  // --- pantalla de entrada --------------------------------------------------
  if (phase === "join" || (phase === "connecting" && !identity)) {
    return (
      <JoinScreen
        onJoin={(enteredPin, alias, wanted, hostToken) =>
          void enterRoom({
            pin: enteredPin,
            alias,
            hostToken,
            startInputAs: wanted,
          })
        }
        onLobby={(who, wanted) => void enterLobby(who, wanted)}
        busy={phase === "connecting"}
        status={status}
        error={error}
      />
    );
  }

  // --- lobby del estudiante -------------------------------------------------
  if (phase === "lobby" || (phase === "connecting" && identity?.role === "student")) {
    return (
      <div className="stage">
        <LobbyStage
          salones={salones}
          input={inputRef.current}
          abierto={salonAbierto}
          codigo={code}
          error={codeError}
          busy={phase === "connecting"}
          onOpen={(salon) => {
            setOpenSalon(salon.salon);
            setCode("");
            setCodeError(null);
          }}
          onDigit={(digit) => setCode((value) => (value + digit).slice(0, 6))}
          onBackspace={() => setCode((value) => value.slice(0, -1))}
          onSubmit={() =>
            identity &&
            salonAbierto &&
            void enterRoom({
              pin: code,
              alias: identity.displayName,
              salon: salonAbierto.salon,
            })
          }
          onCancel={() => {
            setOpenSalon(null);
            setCode("");
            setCodeError(null);
          }}
        />

        <div className="hud-top">
          <span className="chip">Lobby</span>
          <span className="chip">
            Eres <b>{identity?.displayName}</b>
          </span>
          {handTracking && (
            <span className="chip mono" title="Detección de manos">
              {detectFps} det
            </span>
          )}
          {phase === "connecting" && (
            <span className="chip editing">{status || "Entrando..."}</span>
          )}
        </div>

        <div className="hud-help">
          {salonAbierto ? (
            <>
              Escribe el <b>código</b> que te dio tu profesor · apunta a una tecla y{" "}
              <b>deja la mano quieta</b>, o pellizca
            </>
          ) : (
            <>
              <b>Apunta</b> a un portal para entrar a su salón · la tabla de la derecha
              dice qué hay hoy · usa los deslizadores para mirar alrededor
            </>
          )}
        </div>

        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Cerrar aviso">
              ×
            </button>
          </div>
        )}

        <CameraControls
          input={inputRef.current}
          handTracking={handTracking}
          showLandmarks={showLandmarks}
          onToggleLandmarks={setShowLandmarks}
        />
        {handTracking && showLandmarks && <LandmarkOverlay input={inputRef.current} />}
      </div>
    );
  }

  if (!handle || !scene) {
    return (
      <JoinScreen
        onJoin={(enteredPin, alias, wanted, hostToken) =>
          void enterRoom({ pin: enteredPin, alias, hostToken, startInputAs: wanted })
        }
        onLobby={(who, wanted) => void enterLobby(who, wanted)}
        busy
        status={status}
        error={error}
      />
    );
  }

  // El editor es del profesor y solo hasta que pulsa comenzar. Para todos los
  // demás, esta fase simplemente no existe.
  const editing = identity?.role === "teacher" && roomPhase === "editing";

  return (
    <div className="stage">
      <Stage
        room={handle.room}
        sessionId={handle.sessionId}
        scene={scene}
        playerIds={playerIds}
        objectIds={objectIds}
        envId={envId}
        editing={editing}
        catalog={catalog}
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
        roomName={scene.roomName}
        salon={scene.salon}
        editing={editing}
        participants={playerIds.length}
        capacity={scene.capacity}
        micOn={micOn}
        voiceOn={voiceOn}
        onToggleMic={async () => {
          const next = !micOn;
          await voiceRef.current?.setMicrophone(next);
          setMicOn(next);
        }}
        onLeave={leave}
        onClose={
          identity?.role === "teacher"
            ? () => {
                handle.room.send("close");
                void leave();
              }
            : null
        }
      />
      <CameraControls
        input={inputRef.current}
        handTracking={handTracking}
        showLandmarks={showLandmarks}
        onToggleLandmarks={setShowLandmarks}
      />
      {handTracking && showLandmarks && <LandmarkOverlay input={inputRef.current} />}
    </div>
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
