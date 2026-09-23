/**
 * Estado sincronizado de la sala.
 *
 * Los campos de pose usan `t.quantized` / `t.angle` en vez de float32 para
 * respetar el presupuesto de red de la seccion 05 del documento: una posicion
 * de 16 bits sobre un rango de 12 m da ~0,2 mm de resolucion y cuesta 2 bytes
 * en vez de 4. Con cabeza + dos manos por participante la carga util queda
 * cerca de los 48 bytes por tick que estima el documento.
 */
import { schema, t, type SchemaType } from "@colyseus/schema";

/** Rango de coordenadas cuantizadas, en metros. Cubre una sala de 12x12x6. */
const POS_XZ = { min: -6, max: 6, bits: 16 } as const;
const POS_Y = { min: -1, max: 5, bits: 16 } as const;

/** Gestos de la capa de entrada (seccion 10). Se transmite el indice, no el nombre. */
export const GESTURE = {
  none: 0,
  point: 1,
  pinch: 2,
  fist: 3,
  open: 4,
} as const;

export const Hand = schema(
  {
    tracked: t.boolean().default(false),
    gesture: t.uint8().default(GESTURE.none),
    x: t.quantized(POS_XZ).default(0),
    y: t.quantized(POS_Y).default(0),
    z: t.quantized(POS_XZ).default(0),
  },
  "Hand",
);
export type Hand = SchemaType<typeof Hand>;

export const Player = schema(
  {
    alias: t.string().default(""),
    role: t.string<"teacher" | "student">().default("student"),
    color: t.string().default("#0B6E67"),
    spotId: t.string().default(""),
    /** Identidad en LiveKit: enlaza esta voz con este avatar. */
    voiceId: t.string().default(""),
    handRaised: t.boolean().default(false),
    speaking: t.boolean().default(false),

    // Cabeza: posicion + yaw/pitch. Sin roll, que en la fase 1 nadie inclina
    // la cabeza (la camara vive en el punto asignado).
    hx: t.quantized(POS_XZ).default(0),
    hy: t.quantized(POS_Y).default(1.6),
    hz: t.quantized(POS_XZ).default(0),
    yaw: t.angle(),
    pitch: t.quantized({ min: -1.4, max: 1.4, bits: 8 }).default(0),

    left: t.ref(Hand),
    right: t.ref(Hand),
  },
  "Player",
);
export type Player = SchemaType<typeof Player>;

export const SceneObject = schema(
  {
    src: t.string().default("prim:box"),
    label: t.string().default(""),
    color: t.string().default("#C9D2D1"),
    sx: t.float32().default(1),
    sy: t.float32().default(1),
    sz: t.float32().default(1),
    x: t.quantized(POS_XZ).default(0),
    y: t.quantized(POS_Y).default(0),
    z: t.quantized(POS_XZ).default(0),
    ry: t.angle(),
    interactive: t.boolean().default(false),
    locked: t.boolean().default(false),
    /** sessionId de quien lo tiene agarrado, o "" si esta libre. */
    heldBy: t.string().default(""),
  },
  "SceneObject",
);
export type SceneObject = SchemaType<typeof SceneObject>;

export const AulaState = schema(
  {
    pin: t.string().default(""),
    environment: t.string().default("white-room"),
    sceneVersion: t.uint16().default(4),
    halfSize: t.float32().default(4),
    players: t.map(Player),
    objects: t.map(SceneObject),
  },
  "AulaState",
);
export type AulaState = SchemaType<typeof AulaState>;
