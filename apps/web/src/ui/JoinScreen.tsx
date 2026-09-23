import { useEffect, useState } from "react";
import { createSession, type CreatedSession } from "../net/api";

export type InputMode = "camera" | "mouse";

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
      const created = await createSession(code.trim());
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
            <h1>Tu salón está abierto</h1>
            <p className="lede">
              Comparte este PIN con tus estudiantes. El salón queda en pie aunque todavía
              no haya entrado nadie.
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
            <p className="hint">
              Ahora entra tú para dar la clase. Eres el único con el control del salón:
              esa credencial vive solo en este navegador.
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
            <button
              className="primary"
              type="button"
              onClick={handleCreate}
              disabled={creating || code.trim().length < 4}
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
                  ? "Entrar a dar la clase"
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
