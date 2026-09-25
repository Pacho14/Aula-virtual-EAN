import { useEffect, useState } from "react";
import { createSession, type CreatedSession } from "../net/api";

export type InputMode = "camera" | "mouse";

/** El mismo tope que aplica el servidor en makeScene. */
const MAX_STUDENTS = 12;
/** Los tres salones del lobby. */
const SALONES = [1, 2, 3] as const;

/**
 * Se guarda el salón creado para que recargar la página no le quite la clase
 * al profesor: el hostToken no se puede volver a pedir.
 */
const STORE_KEY = "aula.salon";

function loadStored(): CreatedSession | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CreatedSession;
    return parsed.expiresAt > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

/** Forma de correo, nada más. Ver el comentario en el campo. */
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function JoinScreen({
  onJoin,
  onLobby,
  busy,
  status,
  error,
}: {
  /** Entrada del profesor al salón que acaba de crear. */
  onJoin: (pin: string, alias: string, mode: InputMode, hostToken: string) => void;
  /** Entrada del estudiante al lobby: todavía no tiene ningún código. */
  onLobby: (identity: { email: string; displayName: string }, mode: InputMode) => void;
  busy: boolean;
  status: string;
  error: string | null;
}) {
  const [tab, setTab] = useState<"student" | "teacher">("student");
  const [mode, setMode] = useState<InputMode>("camera");

  // --- estudiante ---------------------------------------------------------
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");

  // --- profesor -----------------------------------------------------------
  const [code, setCode] = useState("");
  const [salon, setSalon] = useState<number>(1);
  const [roomName, setRoomName] = useState("");
  const [students, setStudents] = useState("5");
  const [minutos, setMinutos] = useState("120");
  const [alias, setAlias] = useState("");
  const [created, setCreated] = useState<CreatedSession | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const stored = loadStored();
    if (stored) {
      setCreated(stored);
      setTab("teacher");
    }
  }, []);

  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      const session = await createSession({
        code: code.trim(),
        roomName: roomName.trim(),
        students: clamp(Number(students) || 5, 1, MAX_STUDENTS),
        salon,
        minutos: clamp(Number(minutos) || 60, 5, 8 * 60),
      });
      setCreated(session);
      sessionStorage.setItem(STORE_KEY, JSON.stringify(session));
    } catch (problem) {
      setCreateError((problem as Error).message);
    } finally {
      setCreating(false);
    }
  }

  function discard() {
    sessionStorage.removeItem(STORE_KEY);
    setCreated(null);
    setCopied(false);
  }

  const studentReady = CORREO.test(email.trim()) && displayName.trim().length >= 2 && !busy;
  const teacherReady = created !== null && alias.trim().length >= 2 && !busy;

  return (
    <div className="join">
      <form
        className="join-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (tab === "student") {
            if (studentReady) {
              onLobby({ email: email.trim(), displayName: displayName.trim() }, mode);
            }
          } else if (teacherReady && created) {
            onJoin(created.pin, alias.trim(), mode, created.hostToken);
          }
        }}
      >
        <p className="eyebrow">Aula EAN Visual</p>

        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "student"}
            className={tab === "student" ? "on" : ""}
            onClick={() => setTab("student")}
          >
            Soy estudiante
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "teacher"}
            className={tab === "teacher" ? "on" : ""}
            onClick={() => setTab("teacher")}
          >
            Soy profesor
          </button>
        </div>

        {tab === "student" ? (
          <>
            <h1>Entra a la experiencia</h1>
            <p className="lede">
              No necesitas ningún código todavía. Entras al lobby, ves los tres salones y
              su estado, y el código te hará falta al elegir uno.
            </p>

            <label className="field">
              <span>Correo institucional</span>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="estudiante@universidad.edu"
                autoComplete="email"
                inputMode="email"
              />
            </label>

            <label className="field">
              <span>¿Cómo quieres que te vean?</span>
              <input
                id="alias"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Juan"
                maxLength={32}
                autoComplete="off"
              />
            </label>
            <p className="hint">
              Ese es el nombre que llevará tu avatar dentro de la clase.
            </p>
          </>
        ) : created ? (
          <>
            <h1>{created.roomName}</h1>
            <p className="lede">
              Salón {created.salon}. Entra tú primero a armar la escena: mientras la armas
              nadie puede entrar, y el código empieza a servir cuando pulses comenzar.
            </p>
            <div className="pin-show">
              <span>Código</span>
              <b>{created.pin}</b>
              <button
                type="button"
                className="ghost small"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(created.pin);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? "Copiado" : "Copiar"}
              </button>
            </div>
            <dl className="summary">
              <div>
                <dt>Salón</dt>
                <dd>{created.salon}</dd>
              </div>
              <div>
                <dt>Estudiantes</dt>
                <dd>{created.students}</dd>
              </div>
              <div>
                <dt>Duración</dt>
                <dd>{formatMinutes(created.minutos)}</dd>
              </div>
            </dl>

            <label className="field">
              <span>¿Cómo quieres que te vean?</span>
              <input
                id="alias"
                value={alias}
                onChange={(event) => setAlias(event.target.value)}
                placeholder="Profesora Ramírez"
                maxLength={32}
                autoComplete="off"
              />
            </label>

            <p className="hint">
              Eres la única persona con el control de este salón: esa credencial vive solo
              en este navegador. Reparte el código cuando quieras; quien llegue antes de
              tiempo verá en su portal que estás preparando la sala.
            </p>
          </>
        ) : (
          <>
            <h1>Abre una clase</h1>
            <p className="lede">
              Solo un profesor puede abrir salones. El código de profesor aparece en la
              consola del servidor al arrancar.
            </p>

            <label className="field">
              <span>Código de profesor</span>
              <input
                id="code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="por ejemplo a1b2c3d4"
                autoComplete="off"
              />
            </label>

            <fieldset className="choice">
              <legend>¿En qué salón?</legend>
              {SALONES.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={salon === n ? "on" : ""}
                  onClick={() => setSalon(n)}
                >
                  Salón {n}
                </button>
              ))}
            </fieldset>

            <label className="field">
              <span>Nombre de la clase</span>
              <input
                id="roomName"
                value={roomName}
                onChange={(event) => setRoomName(event.target.value)}
                placeholder="Impresión 3D"
                maxLength={48}
                autoComplete="off"
              />
            </label>

            <div className="field-row">
              <label className="field">
                <span>Cuántos estudiantes</span>
                <input
                  id="students"
                  value={students}
                  onChange={(event) =>
                    setStudents(event.target.value.replace(/\D/g, "").slice(0, 2))
                  }
                  placeholder="5"
                  inputMode="numeric"
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span>Duración en minutos</span>
                <input
                  id="minutos"
                  value={minutos}
                  onChange={(event) =>
                    setMinutos(event.target.value.replace(/\D/g, "").slice(0, 3))
                  }
                  placeholder="120"
                  inputMode="numeric"
                  autoComplete="off"
                />
              </label>
            </div>

            <p className="hint">
              El número de estudiantes reparte los puestos en arco frente a la mesa y fija
              el cupo: va de 1 a {MAX_STUDENTS}. La duración se muestra en el lobby, junto
              al tiempo que lleva la clase abierta.
            </p>

            <button
              className="primary"
              type="button"
              onClick={handleCreate}
              disabled={creating || code.trim().length < 4 || roomName.trim().length < 2}
            >
              {creating ? "Abriendo..." : "Abrir la clase"}
            </button>
            {createError && <p className="error">{createError}</p>}
          </>
        )}

        {(tab === "student" || created) && (
          <>
            <fieldset className="choice">
              <legend>Cómo controlas</legend>
              <button
                type="button"
                className={mode === "camera" ? "on" : ""}
                onClick={() => setMode("camera")}
              >
                Manos con cámara
              </button>
              <button
                type="button"
                className={mode === "mouse" ? "on" : ""}
                onClick={() => setMode("mouse")}
              >
                Mouse o toque
              </button>
            </fieldset>

            {mode === "camera" && (
              <p className="hint">
                Apoya el teléfono en un soporte, en horizontal, y deja las manos libres
                frente a la cámara, a unos 50 cm. Necesitas luz de frente, no a contraluz.
              </p>
            )}

            <button
              className="primary"
              type="submit"
              disabled={tab === "student" ? !studentReady : !teacherReady}
            >
              {busy
                ? status || "Entrando..."
                : tab === "student"
                  ? "Entrar a la experiencia"
                  : "Entrar a armar el salón"}
            </button>

            {error && <p className="error">{error}</p>}

            {tab === "teacher" && created && (
              <button className="ghost small" type="button" onClick={discard}>
                Abrir otra clase
              </button>
            )}
          </>
        )}
      </form>
    </div>
  );
}

export function formatMinutes(total: number) {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}
