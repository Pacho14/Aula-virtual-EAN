/**
 * El imán, del lado del cliente.
 *
 * Espejo exacto de `snapToPlacement` en apps/server/src/scene.ts. Está
 * duplicado porque el servidor y el cliente no comparten paquete todavía -lo
 * mismo pasa con `aimAt`-, y tiene que estar duplicado bien: el servidor es la
 * autoridad, así que si aquí se predice otra posición, la pieza da un salto en
 * el momento de soltarla, que es justo cuando más se nota.
 *
 * Si cambias una, cambia la otra.
 */
import type { PlacementZone } from "../net/api";

export interface Placed {
  x: number;
  y: number;
  z: number;
  onTable: boolean;
}

export function snapToPlacement(
  zone: PlacementZone,
  x: number,
  z: number,
  half: readonly [number, number, number],
): Placed {
  const floorX = clamp(
    x,
    zone.floor.center[0] - zone.floor.half[0],
    zone.floor.center[0] + zone.floor.half[0],
  );
  const floorZ = clamp(
    z,
    zone.floor.center[1] - zone.floor.half[1],
    zone.floor.center[1] + zone.floor.half[1],
  );

  const overTable =
    Math.abs(floorX - zone.table.center[0]) <= zone.table.half[0] + zone.reach &&
    Math.abs(floorZ - zone.table.center[1]) <= zone.table.half[1] + zone.reach;

  if (overTable) {
    const marginX = Math.max(0, zone.table.half[0] - half[0]);
    const marginZ = Math.max(0, zone.table.half[1] - half[2]);
    return {
      x: magnet(
        clamp(floorX, zone.table.center[0] - marginX, zone.table.center[0] + marginX),
        zone,
      ),
      y: zone.table.top + half[1],
      z: magnet(
        clamp(floorZ, zone.table.center[1] - marginZ, zone.table.center[1] + marginZ),
        zone,
      ),
      onTable: true,
    };
  }

  return {
    x: magnet(floorX, zone),
    y: half[1],
    z: magnet(floorZ, zone),
    onTable: false,
  };
}

function magnet(value: number, zone: PlacementZone) {
  const nearest = Math.round(value / zone.grid) * zone.grid;
  return Math.abs(value - nearest) < zone.grid * zone.pull ? nearest : value;
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}
