/**
 * Voz por LiveKit con audio espacial.
 *
 * Nota de infraestructura (seccion 12 del documento): el tunel de Cloudflare
 * transporta la app, la API y el WebSocket de Colyseus, pero NO el UDP de
 * WebRTC. Por eso LIVEKIT_URL apunta fuera del tunel -en la fase 1, a LiveKit
 * Cloud-. Si esa variable esta vacia la app funciona completa pero muda, y lo
 * dice en pantalla en vez de fallar en silencio.
 *
 * Cada voz remota pasa por un PannerNode ubicado en la cabeza de su avatar.
 */
import {
  Room as LiveKitRoom,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";

interface Speaker {
  panner: PannerNode;
  gain: GainNode;
  /** Elemento mudo: Chrome deja de bombear el stream si no esta adjunto. */
  element: HTMLMediaElement;
  source: MediaStreamAudioSourceNode;
}

export class Voice {
  private room: LiveKitRoom | null = null;
  private ctx: AudioContext | null = null;
  private speakers = new Map<string, Speaker>();
  private activeIds = new Set<string>();

  /** voiceId de quienes estan hablando ahora mismo. */
  get speaking(): ReadonlySet<string> {
    return this.activeIds;
  }

  get connected() {
    return this.room !== null;
  }

  async connect(url: string, token: string) {
    // El AudioContext debe crearse tras un gesto del usuario; se llama a esto
    // desde el boton de entrar, no al cargar la pagina.
    this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();

    const room = new LiveKitRoom({ adaptiveStream: true, dynacast: true });
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed);
    room.on(RoomEvent.ActiveSpeakersChanged, (participants) => {
      this.activeIds = new Set(participants.map((p) => p.identity));
    });

    await room.connect(url, token);
    await room.localParticipant.setMicrophoneEnabled(true);
  }

  private onTrackSubscribed = (
    track: RemoteTrack,
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (track.kind !== Track.Kind.Audio || !this.ctx) return;

    const element = track.attach();
    element.muted = true;
    element.style.display = "none";
    document.body.appendChild(element);

    const source = this.ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    const panner = this.ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 1;
    // Una voz sigue siendo inteligible a lo ancho de la sala, pero se ubica.
    panner.maxDistance = 12;
    panner.rolloffFactor = 0.8;

    const gain = this.ctx.createGain();
    source.connect(panner).connect(gain).connect(this.ctx.destination);

    this.speakers.set(participant.identity, { panner, gain, element, source });
  };

  private onTrackUnsubscribed = (
    track: RemoteTrack,
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (track.kind !== Track.Kind.Audio) return;
    const speaker = this.speakers.get(participant.identity);
    if (!speaker) return;
    speaker.source.disconnect();
    speaker.panner.disconnect();
    speaker.gain.disconnect();
    track.detach(speaker.element);
    speaker.element.remove();
    this.speakers.delete(participant.identity);
  };

  /** Mueve la voz de un participante a la posicion de su avatar. */
  setSpeakerPosition(voiceId: string, x: number, y: number, z: number) {
    const speaker = this.speakers.get(voiceId);
    if (!speaker || !this.ctx) return;
    const at = this.ctx.currentTime;
    speaker.panner.positionX.setTargetAtTime(x, at, 0.05);
    speaker.panner.positionY.setTargetAtTime(y, at, 0.05);
    speaker.panner.positionZ.setTargetAtTime(z, at, 0.05);
  }

  /** Mueve el oyente con la camara del estudiante. */
  setListener(
    px: number,
    py: number,
    pz: number,
    fx: number,
    fy: number,
    fz: number,
  ) {
    const listener = this.ctx?.listener;
    if (!listener || !this.ctx) return;
    const at = this.ctx.currentTime;
    if (listener.positionX) {
      listener.positionX.setTargetAtTime(px, at, 0.02);
      listener.positionY.setTargetAtTime(py, at, 0.02);
      listener.positionZ.setTargetAtTime(pz, at, 0.02);
      listener.forwardX.setTargetAtTime(fx, at, 0.02);
      listener.forwardY.setTargetAtTime(fy, at, 0.02);
      listener.forwardZ.setTargetAtTime(fz, at, 0.02);
      listener.upX.setTargetAtTime(0, at, 0.02);
      listener.upY.setTargetAtTime(1, at, 0.02);
      listener.upZ.setTargetAtTime(0, at, 0.02);
    } else {
      // Safari todavia usa el API antiguo.
      (listener as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(px, py, pz);
      (
        listener as unknown as {
          setOrientation(x: number, y: number, z: number, ux: number, uy: number, uz: number): void;
        }
      ).setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  async setMicrophone(enabled: boolean) {
    await this.room?.localParticipant.setMicrophoneEnabled(enabled);
  }

  get microphoneEnabled() {
    return this.room?.localParticipant.isMicrophoneEnabled ?? false;
  }

  async disconnect() {
    for (const [, speaker] of this.speakers) {
      speaker.source.disconnect();
      speaker.panner.disconnect();
      speaker.gain.disconnect();
      speaker.element.remove();
    }
    this.speakers.clear();
    await this.room?.disconnect();
    this.room = null;
    await this.ctx?.close();
    this.ctx = null;
  }
}
