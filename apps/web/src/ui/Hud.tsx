import { GESTURE_LABEL, type Gesture } from "../input/types";
import type { HudSnapshot } from "../scene/LocalPlayer";

export function Hud({
  snapshot,
  pin,
  roomName,
  salon,
  editing,
  participants,
  capacity,
  micOn,
  voiceOn,
  onToggleMic,
  onToggleHand,
  onLeave,
  onClose,
}: {
  snapshot: HudSnapshot;
  pin: string;
  roomName: string;
  /** En cuál de los tres salones del lobby está la clase. */
  salon: number;
  /** El profesor armando la escena, antes de abrir el salón. */
  editing: boolean;
  participants: number;
  capacity: number;
  micOn: boolean;
  voiceOn: boolean;
  onToggleMic: () => void;
  /** Levanta o baja la mano a mano: en modo mouse/toque el gesto no alcanza a sostenerse. */
  onToggleHand: () => void;
  onLeave: () => void;
  /** Solo el profesor: cierra el salón y lo deja libre para la clase siguiente. */
  onClose: (() => void) | null;
}) {
  const gesture = snapshot.gesture as Gesture;

  return (
    <>
      <div className="hud-top">
        <span className="chip">
          Salón {salon} · {roomName || "Clase"}
        </span>
        <span className="chip">
          Código <b>{pin || "—"}</b>
        </span>
        {editing ? (
          <span className="chip editing">Armando el salón · nadie ha entrado</span>
        ) : (
          <span className="chip">
            En la sala <b>{participants}</b> de {capacity}
          </span>
        )}
        {snapshot.handRaised && <span className="chip raised">Pediste la palabra</span>}
      </div>

      <div className="hud-bottom">
        <div className="hud-group">
          <span className={`gesture g-${gesture}`}>{GESTURE_LABEL[gesture] ?? "—"}</span>
          {snapshot.held ? (
            <span className="chip held">Tienes: {snapshot.held}</span>
          ) : snapshot.hovered ? (
            <span className="chip">Apuntando: {snapshot.hovered}</span>
          ) : null}
        </div>

        <div className="hud-group">
          <button
            className={`icon ${micOn ? "on" : ""}`}
            onClick={onToggleMic}
            disabled={!voiceOn}
            title={voiceOn ? "Micrófono" : "La voz no está configurada en este servidor"}
          >
            {voiceOn ? (micOn ? "Micrófono activo" : "Micrófono en silencio") : "Sin voz"}
          </button>
          {!editing && (
            <button
              className={`icon ${snapshot.handRaised ? "on" : ""}`}
              onClick={onToggleHand}
              title="Pedir o dejar de pedir la palabra"
            >
              {snapshot.handRaised ? "Bajar la mano" : "Pedir la palabra"}
            </button>
          )}
          <span className="chip mono" title="Render / detección de manos">
            {snapshot.renderFps} fps · {snapshot.source === "camera" ? `${snapshot.detectFps} det` : "mouse"}
          </span>
          {onClose && (
            <button className="icon danger" onClick={onClose} title="Deja el salón libre">
              Cerrar la clase
            </button>
          )}
          <button className="icon" onClick={onLeave}>
            Salir
          </button>
        </div>
      </div>

      <div className="hud-help">
        {editing ? (
          snapshot.source === "camera" ? (
            <>
              <b>Apunta y espera</b> a que se llene el anillo —o <b>cierra la mano</b>,
              que es lo mismo pero ya · los deslizadores se quedan <b>enganchados</b>{" "}
              hasta que cierres la mano otra vez · la pieza que sacas{" "}
              <b>ya viene en la mano</b>: llévala a la mesa y <b>abre la mano</b> para
              soltarla
            </>
          ) : (
            <>
              <b>Click</b> en un botón para pulsarlo · la pieza que sacas{" "}
              <b>ya viene en el cursor</b>: llévala a la mesa y <b>haz click</b> para
              soltarla · la mesa la atrae sola
            </>
          )
        ) : snapshot.source === "camera" ? (
          <>
            <b>Apunta y espera</b> a que se llene el anillo —o <b>cierra la mano</b>,
            que es lo mismo pero ya · <b>abre la mano</b> para soltar la pieza · los
            deslizadores se quedan <b>enganchados</b> hasta que cierres la mano otra
            vez · <b>mano arriba 1 s</b> pide la palabra
          </>
        ) : (
          <>
            <b>Click y arrastra</b> agarra y suelta · <b>click</b> selecciona · el botón{" "}
            <b>Pedir la palabra</b> la pide
          </>
        )}
      </div>
    </>
  );
}
