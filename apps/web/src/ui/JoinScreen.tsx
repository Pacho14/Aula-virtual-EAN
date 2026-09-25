import { useEffect, useState } from "react";
import { createSession, type CreatedSession } from "../net/api";

export type InputMode = "camera" | "mouse";

/** El mismo tope que aplica el servidor en makeScene. */
const MAX_STUDENTS = 12;

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

export function JoinScreen({
  onJoin,
  busy,
  status,
  error,
}: {
  onJoin: (pin: string, alias: string, mode: InputMode, hostToken?: string) => void;
  busy: boolean;
  status: string;
  error: string | null;
}) {
  const [tab, setTab] = useState<"student" | "teacher">("student");
  const [pin, setPin] = useState("");
  const [alias, setAlias] = useState("");
  const [mode, setMode] = useState<InputMode>("camera");

  const [code, setCode] = useState("");
  const [roomName, setRoomName] = useState("");
  /**
   * Se guarda como texto y se ajusta al crear, no en cada tecla.
   *
   * Recortando al vuelo, reemplazar un 5 por un 8 escribe "58" y el campo lo
   * corrige a 12 delante de quien escribe. Eso confunde mucho más que ver el
   * número fuera de rango un segundo.
   */
  const [students, setStudents] = useState("5");
  const [salon, setSalon] = useState<CreatedSession | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const stored = loadStored();
    if (stored) {
      setSalon(stored);
      setTab("teacher");
    }
  }, []);

  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createSession(
        code.trim(),
        roomName.trim(),
        Math.min(MAX_STUDENTS, Math.max(1, Number(students) || 5)),
      );
      setSalon(created);
      sessionStorage.setItem(STORE_KEY, JSON.stringify(created));
    } catch (problem) {
      setCreateError((problem as Error).message);
    } finally {
      setCreating(false);
    }
  }

  function discard() {
    sessionStorage.removeItem(STORE_KEY);
    setSalon(null);
    setCopied(false);
  }

  const isTeacher = tab === "teacher" && salon !== null;
  const effectivePin = isTeacher ? salon.pin : pin;
  const canSubmit = /^\d{6}$/.test(effectivePin) && alias.trim().length >= 2 && !busy;

  return (
    <div className="join">
      <form
        className="join-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) {
            onJoin(effectivePin, alias.trim(), mode, isTeacher ? salon.hostToken : undefined);
          }
        }}
      >
        <p className="eyebrow">Aula EAN Visual · fase 1</p>

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
            <h1>Entra al salón</h1>
            <p className="lede">
              Necesitas el PIN de seis dígitos que te compartió tu profesor. La cámara se
              usa solo para leer tus manos: el video no sale de este dispositivo.
            </p>
            <label className="field">
              <span>PIN del salón</span>
              <input
                id="pin"
                value={pin}
                onChange={(event) =>
                  setPin(event.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="000000"
                inputMode="numeric"
                className="pin-input"
                autoComplete="off"
              />
            </label>
          </>
        ) : salon ? (
          <>
            <h1>{salon.roomName}</h1>
            <p className="lede">
              El salón ya existe. Entra tú primero a armar la escena: mientras la armas
              nadie puede entrar, y el PIN empieza a servir cuando pulses comenzar.
            </p>
            <div className="pin-show">
              <span>PIN</span>
              <b>{salon.pin}</b>
              <button
                type="button"
                className="ghost small"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(salon.pin);
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
                <dt>Estudiantes</dt>
                <dd>{salon.students}</dd>
              </div>
              <div>
                <dt>Cupo con el profesor</dt>
                <dd>{salon.students + 1}</dd>
              </div>
            </dl>
            <p className="hint">
              Eres el único con el control del salón: esa credencial vive solo en este
              navegador. Reparte el PIN cuando quieras; quien llegue antes de tiempo
              verá que estás preparando la sala y entrará solo al abrirla.
            </p>
          </>
        ) : (
          <>
            <h1>Crea el salón</h1>
            <p className="lede">
              Solo un profesor puede abrir salones. El código aparece en la consola del
              servidor al arrancar.
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
            <label className="field">
              <span>Nombre de la sala</span>
              <input
                id="roomName"
                value={roomName}
                onChange={(event) => setRoomName(event.target.value)}
                placeholder="Mantenimiento de válvulas"
                maxLength={48}
                autoComplete="off"
              />
            </label>
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
            <p className="hint">
              De aquí salen los puestos: se reparten en arco frente a la mesa, y el
              salón no admite a nadie más. Van de 1 a {MAX_STUDENTS}. Medido de verdad
              hay hasta seis; por encima de eso todavía no sabemos si aguanta los 30 fps
              en celular.
            </p>
            <button
              className="primary"
              type="button"
              onClick={handleCreate}
              disabled={creating || code.trim().length < 4 || roomName.trim().length < 2}
            >
              {creating ? "Creando..." : "Crear salón"}
            </button>
            {createError && <p className="error">{createError}</p>}
          </>
        )}

        {(tab === "student" || salon) && (
          <>
            <label className="field">
              <span>Tu nombre</span>
              <input
                id="alias"
                value={alias}
                onChange={(event) => setAlias(event.target.value)}
                placeholder="Como quieres que te vean"
                maxLength={32}
                autoComplete="off"
              />
            </label>

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
                Apoya el teléfono en un soporte y deja las manos libres frente a la
                cámara, a unos 50 cm. Necesitas luz de frente, no a contraluz.
              </p>
            )}

            <button className="primary" type="submit" disabled={!canSubmit}>
              {busy
                ? status || "Entrando..."
                : isTeacher
                  ? "Entrar a armar el salón"
                  : "Entrar al salón"}
            </button>

            {error && <p className="error">{error}</p>}

            {isTeacher && (
              <button className="ghost small" type="button" onClick={discard}>
                Crear otro salón
              </button>
            )}
          </>
        )}
      </form>
    </div>
  );
}
