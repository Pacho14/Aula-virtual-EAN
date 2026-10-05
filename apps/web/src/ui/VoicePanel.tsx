/**
 * Quien tiene el microfono activo, y el control del profesor sobre el de
 * los demas.
 *
 * Mismo patron de sondeo que `HandQueue`: el estado de Colyseus no pasa por
 * React, asi que esto lee `room.state.players` por su cuenta unas pocas
 * veces por segundo en vez de re-renderizar con cada pose que llega.
 */
import { useEffect, useRef, useState } from "react";
import type { AulaRoom } from "../net/room";

interface Entry {
  id: string;
  alias: string;
  micOn: boolean;
  teacherMuted: boolean;
  speaking: boolean;
  isSelf: boolean;
}

const POLL_MS = 300;

export function VoicePanel({
  room,
  sessionId,
  isTeacher,
  voiceOn,
}: {
  room: AulaRoom;
  sessionId: string;
  isTeacher: boolean;
  /** Si la voz está configurada y conectada en este servidor. */
  voiceOn: boolean;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const last = useRef("");

  useEffect(() => {
    let handle = 0;

    const pump = () => {
      handle = window.setTimeout(pump, POLL_MS);

      const next: Entry[] = [];
      room.state.players.forEach((player, id) => {
        next.push({
          id,
          alias: player.alias,
          micOn: player.micOn,
          teacherMuted: player.teacherMuted,
          speaking: player.speaking,
          isSelf: id === sessionId,
        });
      });
      // El profesor primero, y luego por nombre: asi no salta de lugar cada
      // vez que alguien habla.
      next.sort((a, b) => (a.isSelf === b.isSelf ? a.alias.localeCompare(b.alias) : a.isSelf ? -1 : 1));

      const key = next
        .map((e) => `${e.id}:${e.micOn ? 1 : 0}:${e.teacherMuted ? 1 : 0}:${e.speaking ? 1 : 0}`)
        .join("|");
      if (key !== last.current) {
        last.current = key;
        setEntries(next);
      }
    };

    pump();
    return () => window.clearTimeout(handle);
  }, [room, sessionId]);

  if (!isTeacher) return null;

  // Sin voz configurada, `micOn` sigue en su valor por defecto del esquema
  // (true) aunque nadie esté hablando: mostrarlo seria decir que la voz
  // funciona cuando no hay ninguna conexión real.
  if (!voiceOn) {
    return (
      <div className="voice-panel">
        <span className="voice-panel-title">Micrófonos</span>
        <p className="voice-panel-empty">La voz no está configurada en este servidor.</p>
      </div>
    );
  }

  return (
    <div className="voice-panel">
      <span className="voice-panel-title">Micrófonos</span>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className={`voice-dot ${entry.speaking ? "speaking" : ""}`} />
            <span className="voice-alias">{entry.alias || "?"}</span>
            {entry.isSelf ? (
              <span className="voice-state">{entry.micOn ? "Activo" : "En silencio"}</span>
            ) : (
              <button
                type="button"
                className={`voice-toggle ${entry.teacherMuted ? "muted" : ""}`}
                onClick={() => room.send("muteStudent", { sessionId: entry.id, v: !entry.teacherMuted })}
              >
                {entry.teacherMuted ? "Silenciado" : entry.micOn ? "Activo" : "En silencio"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
