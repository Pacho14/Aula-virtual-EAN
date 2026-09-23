import { Room, type Client } from "colyseus";
import { AulaState, Hand, Player, SceneObject, GESTURE } from "./state";
import { aimAt, FASE1_SCENE, PLAYER_COLORS, type Scene } from "./scene";
import { consumeTicket, removeSessionByRoomId, type Ticket } from "./tickets";

/**
 * Mensaje de pose. Se envia como arreglo plano de numeros para no pagar
 * las llaves de un objeto 20 veces por segundo:
 *
 *   [hx, hy, hz, yaw, pitch,
 *    lTracked, lGesture, lx, ly, lz,
 *    rTracked, rGesture, rx, ry, rz]
 */
type PoseMessage = number[];

interface JoinOptions {
  ticket?: string;
}

const POSE_LENGTH = 15;

/** Minutos que un salon vacio sigue en pie antes de desecharse. */
const EMPTY_MINUTES_LIMIT = 45;

export class AulaRoom extends Room<{ state: AulaState }> {
  /**
   * El profesor publica el salon y reparte el PIN; los estudiantes llegan
   * despues, a veces bastante despues. Con el valor por defecto (true) una
   * sala recien creada se desecha en segundos por no tener a nadie, y el PIN
   * queda apuntando al vacio. La limpieza la hace el temporizador de abajo.
   */
  override autoDispose = false;

  private scene: Scene = FASE1_SCENE;
  /** spotId -> sessionIds ocupandolo. */
  private occupancy = new Map<string, Set<string>>();
  private colorCursor = 0;
  private emptyMinutes = 0;

  override onCreate(options: { pin?: string; scene?: Scene }) {
    if (options.scene) this.scene = options.scene;

    this.state = new AulaState();
    this.state.pin = options.pin ?? "";
    this.state.environment = this.scene.environment;
    this.state.sceneVersion = this.scene.version;
    this.state.halfSize = this.scene.bounds.halfSize;
    this.maxClients = this.scene.capacity;

    // 20 Hz, como fija la seccion 05 del documento.
    this.setPatchRate(50);

    for (const asset of this.scene.assets) {
      const obj = new SceneObject();
      obj.src = asset.src;
      obj.label = asset.label;
      obj.color = asset.color;
      obj.sx = asset.size[0] * asset.scale;
      obj.sy = asset.size[1] * asset.scale;
      obj.sz = asset.size[2] * asset.scale;
      obj.x = asset.pos[0];
      obj.y = asset.pos[1];
      obj.z = asset.pos[2];
      obj.ry = (asset.rot[1] * Math.PI) / 180;
      obj.interactive = asset.interactive;
      obj.locked = asset.locked;
      this.state.objects.set(asset.id, obj);
    }

    for (const spot of this.scene.spots) {
      this.occupancy.set(spot.id, new Set());
    }

    this.onMessage("pose", (client, raw: PoseMessage) => {
      this.applyPose(client.sessionId, raw);
    });

    this.onMessage("grab", (client, message: { id?: string }) => {
      this.tryGrab(client.sessionId, message?.id);
    });

    this.onMessage("move", (client, message: { id?: string; p?: number[] }) => {
      this.tryMove(client.sessionId, message?.id, message?.p);
    });

    this.onMessage("release", (client, message: { id?: string }) => {
      this.release(client.sessionId, message?.id);
    });

    this.onMessage("raiseHand", (client, message: { v?: boolean }) => {
      const player = this.state.players.get(client.sessionId);
      if (player) player.handRaised = Boolean(message?.v);
    });

    this.onMessage("speaking", (client, message: { v?: boolean }) => {
      const player = this.state.players.get(client.sessionId);
      if (player) player.speaking = Boolean(message?.v);
    });

    // Como autoDispose esta apagado, la sala se recoge sola cuando lleva un
    // rato sin nadie. Sin esto, cada salon creado quedaria vivo para siempre.
    this.clock.setInterval(() => {
      if (this.clients.length > 0) {
        this.emptyMinutes = 0;
        return;
      }
      this.emptyMinutes += 1;
      if (this.emptyMinutes >= EMPTY_MINUTES_LIMIT) this.disconnect();
    }, 60_000);
  }

  override onDispose() {
    // El PIN deja de tener sentido cuando la sala ya no existe: mejor decirle
    // al estudiante que el salon se cerro que dejarlo entrar a la nada.
    removeSessionByRoomId(this.roomId);
  }

  override onJoin(client: Client, options: JoinOptions) {
    // El ticket lo emite la API al validar el PIN. Un cliente no puede
    // entrar a la sala sin haber pasado por ahi.
    const ticket: Ticket | undefined = consumeTicket(options?.ticket);
    if (!ticket || ticket.roomId !== this.roomId) {
      throw new Error("Ticket invalido o vencido. Vuelve a entrar con el PIN.");
    }

    const player = new Player();
    player.alias = ticket.alias.slice(0, 32);
    player.role = ticket.role;
    player.voiceId = ticket.voiceId;
    player.color = PLAYER_COLORS[this.colorCursor++ % PLAYER_COLORS.length]!;
    player.left = new Hand();
    player.right = new Hand();

    const spot = this.claimSpot(client.sessionId, ticket.role);
    if (!spot) throw new Error("No quedan puntos libres en este salon.");
    player.spotId = spot.id;
    player.hx = spot.pos[0];
    player.hy = 1.6;
    player.hz = spot.pos[2];
    // Mirando a la mesa de trabajo, no al centro geometrico de la sala.
    const aim = aimAt(spot.pos, this.scene.focus);
    player.yaw = aim.yaw;
    player.pitch = aim.pitch;

    this.state.players.set(client.sessionId, player);
  }

  override onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      this.occupancy.get(player.spotId)?.delete(client.sessionId);
    }
    // Soltar todo lo que tuviera agarrado, o quedaria bloqueado para siempre.
    this.state.objects.forEach((obj: SceneObject) => {
      if (obj.heldBy === client.sessionId) obj.heldBy = "";
    });
    this.state.players.delete(client.sessionId);
  }

  // --------------------------------------------------------------------

  private claimSpot(sessionId: string, role: "teacher" | "student") {
    const preferred = role === "teacher" ? "prof" : null;
    const order = preferred
      ? [
          ...this.scene.spots.filter((s) => s.id === preferred),
          ...this.scene.spots.filter((s) => s.id !== preferred),
        ]
      : [
          ...this.scene.spots.filter((s) => s.id !== "prof"),
          ...this.scene.spots.filter((s) => s.id === "prof"),
        ];

    for (const spot of order) {
      const taken = this.occupancy.get(spot.id);
      if (taken && taken.size < spot.capacity) {
        taken.add(sessionId);
        return spot;
      }
    }
    return null;
  }

  private applyPose(sessionId: string, raw: PoseMessage) {
    const player = this.state.players.get(sessionId);
    if (!player || !Array.isArray(raw) || raw.length < POSE_LENGTH) return;
    if (raw.some((n) => typeof n !== "number" || !Number.isFinite(n))) return;

    const h = this.scene.bounds.halfSize;
    player.hx = clamp(raw[0]!, -h, h);
    player.hy = clamp(raw[1]!, 0, this.scene.bounds.height);
    player.hz = clamp(raw[2]!, -h, h);
    player.yaw = raw[3]!;
    player.pitch = clamp(raw[4]!, -1.4, 1.4);

    this.applyHand(player.left, raw, 5, h);
    this.applyHand(player.right, raw, 10, h);
  }

  private applyHand(hand: Hand, raw: PoseMessage, offset: number, halfSize: number) {
    hand.tracked = raw[offset] === 1;
    const gesture = raw[offset + 1]!;
    hand.gesture = gesture >= 0 && gesture <= GESTURE.open ? gesture : GESTURE.none;
    hand.x = clamp(raw[offset + 2]!, -halfSize, halfSize);
    hand.y = clamp(raw[offset + 3]!, -1, this.scene.bounds.height);
    hand.z = clamp(raw[offset + 4]!, -halfSize, halfSize);
  }

  private tryGrab(sessionId: string, id?: string) {
    if (!id) return;
    const obj = this.state.objects.get(id);
    if (!obj) return;
    // El servidor decide: un objeto bloqueado o ya tomado no se cede.
    if (!obj.interactive || obj.locked) return;
    if (obj.heldBy !== "" && obj.heldBy !== sessionId) return;
    obj.heldBy = sessionId;
  }

  private tryMove(sessionId: string, id?: string, p?: number[]) {
    if (!id || !Array.isArray(p) || p.length < 3) return;
    const obj = this.state.objects.get(id);
    if (!obj || obj.heldBy !== sessionId) return;
    if (p.some((n) => typeof n !== "number" || !Number.isFinite(n))) return;

    const h = this.scene.bounds.halfSize;
    obj.x = clamp(p[0]!, -h, h);
    obj.y = clamp(p[1]!, 0, this.scene.bounds.height);
    obj.z = clamp(p[2]!, -h, h);
    if (typeof p[3] === "number" && Number.isFinite(p[3])) obj.ry = p[3];
  }

  private release(sessionId: string, id?: string) {
    if (!id) return;
    const obj = this.state.objects.get(id);
    if (obj && obj.heldBy === sessionId) obj.heldBy = "";
  }
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}
