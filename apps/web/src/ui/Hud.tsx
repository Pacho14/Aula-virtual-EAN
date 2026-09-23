import { GESTURE_LABEL, type Gesture } from "../input/types";
import type { HudSnapshot } from "../scene/LocalPlayer";

export function Hud({
  snapshot,
  pin,
  participants,
  micOn,
  voiceOn,
  onToggleMic,
  onLeave,
}: {
  snapshot: HudSnapshot;
  pin: string;
  participants: number;
  micOn: boolean;
  voiceOn: boolean;
  onToggleMic: () => void;
  onLeave: () => void;
}) {
  const gesture = snapshot.gesture as Gesture;

  return (
    <>
      <div className="hud-top">
        <span className="chip">
          PIN <b>{pin || "—"}</b>
        </span>
        <span className="chip">
          En la sala <b>{participants}</b>
        </span>
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
          <span className="chip mono" title="Render / detección de manos">
            {snapshot.renderFps} fps · {snapshot.source === "camera" ? `${snapshot.detectFps} det` : "mouse"}
          </span>
          <button className="icon" onClick={onLeave}>
            Salir
          </button>
        </div>
      </div>

      <div className="hud-help">
        <b>Puño</b> agarra · <b>mano abierta</b> suelta · <b>pellizco</b> selecciona ·{" "}
        <b>mano arriba 1 s</b> pide la palabra
        {snapshot.source === "camera" && <> · arrastra para mirar alrededor</>}
      </div>
    </>
  );
}
