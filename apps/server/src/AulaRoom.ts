import { Room, type Client } from "colyseus";
import { AulaState, ENV_POS, ENV_ROT, ENV_SCALE, Hand, Player, SceneObject, GESTURE } from "./state";
import {
  aimAt,
  isPrimitiveName,
  makeScene,
  PLAYER_COLORS,
  PRIMITIVES,
  snapToPlacement,
  type PrimitiveName,
  type Scene,
  type SceneSpot,
} from "./scene";
import { isKnownEnvironment } from "./environments";
import { consumeTicket, markLive, removeSessionByRoomId, type Ticket } from "./tickets";
import { setCanPublish } from "./voiceAdmin";

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

/**
 * Cuantas piezas puede sacar el profesor del panel de objetos.
 *
 * No es una limitacion tecnica sino de la clase: con mas de una docena de
 * cosas sobre la mesa ya no se distingue cual es cual, y cada una cuesta su
 * parte del presupuesto de dibujo en celular.
 */
const MAX_SPAWNED = 12;

export class AulaRoom extends Room<{ state: AulaState }> {
  /**
   * El profesor publica el salon y reparte el PIN; los estudiantes llegan
   * despues, a veces bastante despues. Con el valor por defecto (true) una
   * sala recien creada se desecha en segundos por no tener a nadie, y el PIN
   * queda apuntando al vacio. La limpieza la hace el temporizador de abajo.
   */
  override autoDispose = false;

  private scene: Scene = makeScene();
  /** spotId -> sessionIds ocupandolo. */
  private occupancy = new Map<string, Set<string>>();
  private colorCursor = 0;
  private emptyMinutes = 0;
  /** Numeracion de las piezas que saca el profesor. No se reutiliza. */
  private spawnCursor = 0;
  /** Numeracion de quien pide la palabra: asi el panel del profesor los ordena por quien la pidio primero, no por quien entro primero al salon. */
  private raiseCursor = 0;

  override onCreate(options: { pin?: string; scene?: Scene }) {
    if (options.scene) this.scene = options.scene;

    this.state = new AulaState();
    this.state.pin = options.pin ?? "";
    this.state.roomName = this.scene.roomName;
    this.state.students = this.scene.students;
    this.state.capacity = this.scene.capacity;
    this.state.phase = "editing";
    this.state.environment = this.scene.environment;
    this.state.sceneVersion = this.scene.version;
    this.state.halfSize = this.scene.bounds.halfSize;
    this.maxClients = this.scene.capacity;

    // La API consulta esto antes de dejar entrar a un estudiante: mientras el
    // profesor arma la escena, el salon existe pero todavia no recibe a nadie.
    this.setMetadata({ phase: "editing", roomName: this.scene.roomName });

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
      if (!player) return;
      const next = Boolean(message?.v);
      if (next === player.handRaised) return;
      player.handRaised = next;
      player.raiseOrder = next ? ++this.raiseCursor : 0;
    });

    this.onMessage("speaking", (client, message: { v?: boolean }) => {
      const player = this.state.players.get(client.sessionId);
      if (player) player.speaking = Boolean(message?.v);
    });

    // --- voz: cada quien reporta su propio mic, el profesor puede forzarlo -

    this.onMessage("mic", (client, message: { v?: boolean }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      // Silenciado por el profesor: no se reactiva solo, ni aunque su propio
      // cliente crea que puede.
      if (player.teacherMuted && message?.v) return;
      player.micOn = Boolean(message?.v);
    });

    this.onMessage("muteStudent", async (client, message: { sessionId?: string; v?: boolean }) => {
      if (!this.isTeacher(client.sessionId)) return;
      const sessionId = String(message?.sessionId ?? "");
      const target = this.state.players.get(sessionId);
      if (!target) return;

      const muted = Boolean(message?.v);
      target.teacherMuted = muted;
      if (muted) target.micOn = false;

      await setCanPublish(this.roomId, target.voiceId, !muted);
      this.clients.get(sessionId)?.send("forceMute", { v: muted });
    });

    // --- editor de escena: solo el profesor, y solo antes de empezar -------

    this.onMessage("spawn", (client, message: { prim?: unknown }) => {
      if (!this.canEdit(client.sessionId)) return;
      if (!isPrimitiveName(message?.prim)) return;
      const id = this.spawn(message.prim);
      // Solo a quien la pidio: su cliente la engancha a la mano sin esperar a
      // buscarla entre los objetos del estado.
      if (id) client.send("spawned", { id });
    });

    this.onMessage("remove", (client, message: { id?: string }) => {
      if (!this.canEdit(client.sessionId)) return;
      const object = this.state.objects.get(String(message?.id ?? ""));
      // La mesa no se quita: es el salon, no una pieza de la escena.
      if (!object || object.locked) return;
      this.state.objects.delete(String(message!.id));
    });

    this.onMessage(
      "env",
      (
        client,
        message: {
          id?: unknown;
          x?: unknown;
          y?: unknown;
          z?: unknown;
          rot?: unknown;
          scale?: unknown;
        },
      ) => {
        // Colocar el entorno es parte de armar el salon, no de darlo: una vez
        // abierta la clase, el paisaje se queda donde el profesor lo dejo.
        if (!this.canEdit(client.sessionId)) return;

        if (typeof message?.id === "string" && isKnownEnvironment(message.id)) {
          this.state.envId = message.id;
        }
        if (isNumber(message?.x)) this.state.envX = clamp(message.x, ENV_POS.min, ENV_POS.max);
        if (isNumber(message?.y)) this.state.envY = clamp(message.y, ENV_POS.min, ENV_POS.max);
        if (isNumber(message?.z)) this.state.envZ = clamp(message.z, ENV_POS.min, ENV_POS.max);
        if (isNumber(message?.rot)) {
          // El giro da la vuelta entera: 359 grados y 1 grado son vecinos.
          const turn = ENV_ROT.max;
          this.state.envRot = ((message.rot % turn) + turn) % turn;
        }
        if (isNumber(message?.scale)) {
          this.state.envScale = clamp(message.scale, ENV_SCALE.min, ENV_SCALE.max);
        }
      },
    );

    this.onMessage("publish", (client) => {
      if (!this.canEdit(client.sessionId)) return;
      this.state.phase = "live";
      this.setMetadata({ phase: "live", roomName: this.state.roomName });
      // El reloj del lobby cuenta desde aqui, no desde que se creo la sala.
      markLive(this.roomId);
    });

    /**
     * Cerrar la clase. Solo el profesor.
     *
     * Hace falta porque los salones son tres y solo admiten una clase cada
     * uno: sin esto, quien termina a las diez deja el salon ocupado
     * cuarenta y cinco minutos y el siguiente profesor no puede abrir.
     */
    this.onMessage("close", (client) => {
      if (!this.isTeacher(client.sessionId)) return;
      this.broadcast("closed", { by: this.state.players.get(client.sessionId)?.alias ?? "" });
      this.disconnect();
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

    // La API ya lo filtra, pero el salon tampoco se fia: mientras el profesor
    // arma la escena, entrar seria ver una sala a medio hacer.
    if (this.state.phase === "editing" && ticket.role !== "teacher") {
      throw new Error("El profesor todavia esta preparando el salon.");
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

    // Una mesa propia por estudiante, aparte de la del profesor. No lleva
    // piezas todavia: es solo para que cada quien vea cual es la suya.
    if (ticket.role === "student") {
      this.state.objects.set(
        studentTableId(spot.id),
        makeStudentTable(spot, player.color, player.alias),
      );
    }
  }

  override onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      this.occupancy.get(player.spotId)?.delete(client.sessionId);
      this.state.objects.delete(studentTableId(player.spotId));
    }
    // Soltar todo lo que tuviera agarrado, o quedaria bloqueado para siempre.
    this.state.objects.forEach((obj: SceneObject) => {
      if (obj.heldBy === client.sessionId) obj.heldBy = "";
    });
    this.state.players.delete(client.sessionId);
  }

  // --------------------------------------------------------------------

  private isTeacher(sessionId: string) {
    return this.state.players.get(sessionId)?.role === "teacher";
  }

  /** Armar la escena es del profesor, y solo antes de que empiece la clase. */
  private canEdit(sessionId: string) {
    return this.state.phase === "editing" && this.isTeacher(sessionId);
  }

  /**
   * Saca una pieza del panel de objetos y la deja sobre la mesa.
   *
   * No aparece siempre en el mismo punto: las piezas se reparten en espiral
   * desde el centro del tablero, porque apiladas en el mismo sitio la segunda
   * tapa a la primera y parece que el panel no hizo nada.
   */
  private spawn(prim: PrimitiveName): string | null {
    let spawned = 0;
    this.state.objects.forEach((object: SceneObject) => {
      if (!object.locked) spawned += 1;
    });
    if (spawned >= MAX_SPAWNED) return null;

    const definition = PRIMITIVES[prim];
    const object = new SceneObject();
    object.src = `prim:${prim}`;
    object.label = definition.label;
    object.color = definition.color;
    object.sx = definition.size[0];
    object.sy = definition.size[1];
    object.sz = definition.size[2];
    object.interactive = true;
    object.locked = false;

    // Angulo aureo: reparte los puntos sin que dos caigan encima del otro.
    const angle = spawned * 2.399963;
    const radius = 0.08 + spawned * 0.035;
    const zone = this.scene.placement;
    const placed = snapToPlacement(
      zone,
      zone.table.center[0] + Math.cos(angle) * radius,
      zone.table.center[1] + Math.sin(angle) * radius,
      [object.sx / 2, object.sy / 2, object.sz / 2],
    );
    object.x = placed.x;
    object.y = placed.y;
    object.z = placed.z;
    // Sin esto la pieza nace sin angulo, y el cliente recibe un giro que no es
    // un numero: la matriz del objeto se llena de NaN y la malla deja de pintar
    // un solo pixel, aunque siga existiendo, en su sitio y en la escena.
    object.ry = 0;

    const id = `pieza-${++this.spawnCursor}`;
    this.state.objects.set(id, object);
    return id;
  }

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

    // El cliente manda a donde apunta la mano; el servidor decide donde cabe.
    // La altura que llega ni se mira: la pone la superficie.
    const placed = snapToPlacement(this.scene.placement, p[0]!, p[2]!, [
      obj.sx / 2,
      obj.sy / 2,
      obj.sz / 2,
    ]);
    obj.x = placed.x;
    obj.y = placed.y;
    obj.z = placed.z;
    if (typeof p[3] === "number" && Number.isFinite(p[3])) obj.ry = p[3];
  }

  private release(sessionId: string, id?: string) {
    if (!id) return;
    const obj = this.state.objects.get(id);
    if (!obj || obj.heldBy !== sessionId) return;
    obj.heldBy = "";

    // Al soltar, el iman encaja del todo: nada queda a medio camino entre dos
    // casillas ni flotando un centimetro sobre el tablero. Se redondea antes
    // de recortar, no despues, o redondear volveria a sacar del tablero lo
    // que el recorte acababa de meter.
    const grid = this.scene.placement.grid;
    const placed = snapToPlacement(
      this.scene.placement,
      Math.round(obj.x / grid) * grid,
      Math.round(obj.z / grid) * grid,
      [obj.sx / 2, obj.sy / 2, obj.sz / 2],
    );
    obj.x = placed.x;
    obj.y = placed.y;
    obj.z = placed.z;
  }
}

function studentTableId(spotId: string) {
  return `mesa-${spotId}`;
}

/**
 * La mesa de un estudiante. Aparte de la del profesor: se crea al entrar y
 * se borra al salir, no es parte fija del salon.
 *
 * Sin piezas encima todavia -no hay zona de colocacion propia por mesa-, asi
 * que no es interactiva: es solo para que cada quien reconozca la suya por
 * el color de su propio avatar.
 */
function makeStudentTable(spot: SceneSpot, color: string, alias: string): SceneObject {
  const table = new SceneObject();
  table.src = "prim:box";
  // El cliente la usa para un rotulo flotante: ver cual es la suya no puede
  // depender solo del color, que a distancia o con mala luz cuesta distinguir.
  table.label = `Mesa de ${alias || "?"}`;
  table.color = color;
  table.sx = 0.8;
  table.sy = 0.62;
  table.sz = 0.6;
  // Entre el puesto y el centro de la sala: delante del estudiante, sin
  // pisar ni su puesto ni la mesa del profesor.
  table.x = spot.pos[0] * 0.7;
  table.y = table.sy / 2;
  table.z = spot.pos[2] * 0.7;
  table.interactive = false;
  table.locked = true;
  return table;
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
