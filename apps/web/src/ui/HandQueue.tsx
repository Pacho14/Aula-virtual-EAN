/**
 * Quien pidio la palabra, para el profesor.
 *
 * Solo el profesor la ve. El orden es el de quien levanto la mano primero,
 * no el de quien entro primero al salon: `raiseOrder` lo fija el servidor en
 * cada `raiseHand`, no cambia con pose ni con nada que viaje a 20 Hz.
 *
 * Es un overlay del DOM con su propio sondeo, como `CameraControls`: el
 * estado de Colyseus no pasa por React, y hacerlo pasar solo para esta lista
 * costaria un render por cada pose que llega. Sondear unas pocas veces por
 * segundo y comparar antes de actualizar evita ambas cosas.
 */
import { useEffect, useRef, useState } from "react";
import type { AulaRoom } from "../net/room";

interface Entry {
  id: string;
  alias: string;
  order: number;
}

const POLL_MS = 200;

export function HandQueue({ room }: { room: AulaRoom }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const last = useRef("");

  useEffect(() => {
    let handle = 0;

    const pump = () => {
      handle = window.setTimeout(pump, POLL_MS);

      const next: Entry[] = [];
      room.state.players.forEach((player, id) => {
        if (player.handRaised) next.push({ id, alias: player.alias, order: player.raiseOrder });
      });
      next.sort((a, b) => a.order - b.order);

      const key = next.map((e) => `${e.id}:${e.order}:${e.alias}`).join("|");
      if (key !== last.current) {
        last.current = key;
        setEntries(next);
      }
    };

    pump();
    return () => window.clearTimeout(handle);
  }, [room]);

  if (entries.length === 0) return null;

  return (
    <div className="hand-queue">
      <span className="hand-queue-title">Piden la palabra</span>
      <ol>
        {entries.map((entry, index) => (
          <li key={entry.id}>
            <b>{index + 1}.</b> {entry.alias || "?"}
          </li>
        ))}
      </ol>
    </div>
  );
}
