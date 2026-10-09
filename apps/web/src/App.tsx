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
import { HandQueue } from "./ui/HandQueue";
import { Hud } from "./ui/Hud";
import { VoicePanel } from "./ui/VoicePanel";
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
  /** Si la fuente de entrada ya está arrancada. Ver `handTracking`. */
  const [inputLive, setInputLive] = useState(false);
  const [showLandmarks, setShowLandmarks] = useState(true);
  const [landmarksExpanded, setLandmarksExpanded] = useState(false);

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

  // El profesor fuerza el silencio desde fuera: el servidor ya se lo aplicó
  // en LiveKit, esto solo pone al día el micrófono local y el HUD.
  useEffect(() => {
    if (!handle) return;
    const off = handle.room.onMessage("forceMute", (message: { v?: boolean }) => {
      const muted = Boolean(message?.v);
      void voiceRef.current?.setMicrophone(!muted);
      setMicOn(!muted);
    });
    return () => off?.();
  }, [handle]);

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
    // Ya corriendo lo que se pide: no se toca. Esto importa desde que la
    // cámara se enciende en la pantalla de entrada, porque entrar a la
    // experiencia vuelve a pedir el mismo modo: sin este guardia la cámara se
    // apagaba y volvía a arrancar justo al entrar -un par de segundos sin
    // manos, el worker recargado y, en algunos navegadores, el permiso otra
    // vez.
    if (inputRef.current.running && inputRef.current.kind === wanted) return null;

    if (wanted === "mouse") {
      await inputRef.current.useMouse();
      setInputLive(true);
      return null;
    }
    try {
      // Sin cadencia que pasarle: la decide el propio detector midiendo lo
      // que cuesta una inferencia en este equipo. Ver `CADENCE` en
      // input/cameraSource.ts -el numero que habia aqui no llegaba a
      // aplicarse nunca en la rama que de verdad corre.
      await inputRef.current.useCamera({ onStatus: setStatus });
      setInputLive(true);
      return null;
    } catch (problem) {
      // Que falle la cámara no puede dejar a nadie fuera: se entra con mouse y
      // se avisa. Es el modo de respaldo que pide la sección 10 del documento.
      console.warn("[entrada] la cámara no arrancó:", problem);
      await inputRef.current.useMouse();
      setInputLive(true);
      // Sin esto, "mode" se queda en "camera" aunque ya se haya caído a
      // mouse: la interfaz sigue hablando de gestos y de pellizco, y los
      // controles de cámara siguen en pantalla, como si hubiera camara.
      setMode("mouse");
      return cameraFailureNotice(problem);
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

  /**
   * Si los controles de la mano pueden funcionar ya.
   *
   * No basta con que el modo elegido sea cámara: hace falta que la fuente esté
   * de verdad arrancada, porque el bucle de los rieles lee el último cuadro
   * del detector. En la pantalla de entrada las dos cosas se separan -se
   * elige el modo antes de que exista la fuente-, y antes no hacía falta
   * distinguirlas porque la cámara arrancaba justo antes de la primera
   * pantalla que las usaba.
   */
  const handTracking = mode === "camera" && inputLive;
  const salonAbierto = salones.find((s) => s.salon === openSalon) ?? null;

  // --- pantalla de entrada --------------------------------------------------
  if (phase === "join" || (phase === "connecting" && !identity)) {
    return (
      // `con-rieles` le hace sitio a los deslizadores: esta pantalla es la
      // única con un formulario debajo, y los rieles flotan fijos sobre todo.
      <div className={handTracking ? "stage con-rieles" : "stage"}>
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
          // Elegir cámara la enciende aquí mismo, antes de entrar a nada.
          //
          // Es lo que hace que los deslizadores de esta pantalla funcionen de
          // verdad, y de paso arregla algo que estaba al revés: la cámara
          // arrancaba **después** de identificarse, así que quien tuviera el
          // permiso bloqueado, la webcam ocupada o mala luz se enteraba con la
          // sesión ya empezada. Ahora se entera antes de escribir su correo, y
          // si falla, la propia pantalla cae a mouse y lo dice.
          onMode={(wanted) => {
            setMode(wanted);
            void startInput(wanted).then((aviso) => {
              if (aviso) setNotice(aviso);
            });
          }}
          mode={mode}
          busy={phase === "connecting"}
          status={status}
          error={error}
        />
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Cerrar aviso">
              ×
            </button>
          </div>
        )}
        {/*
          Solo con la mano andando. En las otras pantallas los deslizadores
          salen siempre -allí giran la vista, y con mouse se arrastran-, pero
          aquí todavía no hay escena que girar: lo único que hacen es dejar
          probar la mano antes de entrar. Sin mano no tienen nada que hacer, y
          encima le quitarían sitio al formulario.
        */}
        {handTracking && (
          <>
            <CameraControls
              input={inputRef.current}
              handTracking={handTracking}
              showLandmarks={showLandmarks}
              onToggleLandmarks={setShowLandmarks}
              landmarksExpanded={landmarksExpanded}
              onToggleExpanded={setLandmarksExpanded}
            />
            {showLandmarks && (
              <LandmarkOverlay input={inputRef.current} expanded={landmarksExpanded} />
            )}
          </>
        )}
      </div>
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
          landmarksExpanded={landmarksExpanded}
          onToggleExpanded={setLandmarksExpanded}
        />
        {handTracking && showLandmarks && (
          <LandmarkOverlay input={inputRef.current} expanded={landmarksExpanded} />
        )}
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
        onMode={(wanted) => {
          setMode(wanted);
          void startInput(wanted).then((aviso) => {
            if (aviso) setNotice(aviso);
          });
        }}
        mode={mode}
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
          handle.room.send("mic", { v: next });
        }}
        onToggleHand={() => {
          const next = !hud.handRaised;
          inputRef.current.setHandRaised(next);
          handle.room.send("raiseHand", { v: next });
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
      {identity?.role === "teacher" && !editing && <HandQueue room={handle.room} />}
      {identity?.role === "teacher" && !editing && (
        <VoicePanel room={handle.room} sessionId={handle.sessionId} isTeacher voiceOn={voiceOn} />
      )}
      <CameraControls
        input={inputRef.current}
        handTracking={handTracking}
        showLandmarks={showLandmarks}
        onToggleLandmarks={setShowLandmarks}
        landmarksExpanded={landmarksExpanded}
        onToggleExpanded={setLandmarksExpanded}
      />
      {handTracking && showLandmarks && (
        <LandmarkOverlay input={inputRef.current} expanded={landmarksExpanded} />
      )}
    </div>
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Por qué falló la cámara, en términos que se puedan arreglar.
 *
 * El error más común no es de este código: es que `getUserMedia` no existe
 * fuera de un contexto seguro (HTTPS, o `localhost`). Entrar por la IP de la
 * red local en HTTP dispara justo este error, y "no se pudo iniciar el
 * seguimiento de manos" no dice por qué ni qué hacer con eso.
 */
function cameraFailureNotice(problem: unknown): string {
  const inseguro = typeof window !== "undefined" && window.isSecureContext === false;
  if (inseguro || !navigator.mediaDevices) {
    return (
      "La cámara necesita una conexión segura: entra por https:// o desde " +
      "\"localhost\", no por una dirección IP en http://. Entraste con mouse o toque."
    );
  }
  if (problem instanceof DOMException && problem.name === "NotAllowedError") {
    return "El navegador bloqueó el permiso de cámara. Entraste con mouse o toque.";
  }
  if (problem instanceof DOMException && problem.name === "NotFoundError") {
    return "No se encontró ninguna cámara en este dispositivo. Entraste con mouse o toque.";
  }
  return "No se pudo iniciar el seguimiento de manos. Entraste con mouse o toque.";
}
