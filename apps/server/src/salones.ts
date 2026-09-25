/**
 * Los tres salones.
 *
 * Hasta ahora una sala era una sala y ya: el profesor la creaba y repartia el
 * PIN. El lobby del estudiante necesita algo a lo que apuntar antes de tener
 * ningun codigo, asi que los salones son tres sitios fijos -como tres aulas de
 * un pasillo- y cada uno admite una clase a la vez.
 *
 * Esto vive en memoria, igual que los PIN. En la fase 3 pasa a Supabase junto
 * con el horario de verdad; la forma de `EstadoSalon` es la que va a viajar.
 */

export const SALONES = [1, 2, 3] as const;
export type SalonId = (typeof SALONES)[number];

export function isSalonId(value: unknown): value is SalonId {
  return value === 1 || value === 2 || value === 3;
}

/**
 * En que punto esta cada salon, tal como lo lee el estudiante en el lobby.
 *
 *   libre        nadie ha abierto nada          SALA NO DISPONIBLE
 *   preparando   el profesor esta armandola     PROFESOR PREPARANDO LA SALA
 *   disponible   abierta y todavia sin nadie    SALA DISPONIBLE
 *   en-curso     abierta y con estudiantes      CLASE EN CURSO
 *   llena        abierta y sin cupo             SALA LLENA
 */
export type EstadoSalon = "libre" | "preparando" | "disponible" | "en-curso" | "llena";

export interface SalonView {
  salon: SalonId;
  estado: EstadoSalon;
  /** Nombre de la clase. Vacio si el salon esta libre. */
  clase: string;
  /** Lo que el profesor calculo que va a durar, en minutos. */
  minutos: number;
  /**
   * Minutos que lleva abierta la clase, o null si todavia no ha empezado.
   * El lobby lo muestra como registro de tiempo y lo refresca solo.
   */
  transcurridos: number | null;
  participantes: number;
  capacidad: number;
}

/** El PIN no sale nunca de aqui: el lobby lo pide, no lo reparte. */
export function describeSalon(
  salon: SalonId,
  datos: {
    clase: string;
    minutos: number;
    phase: "editing" | "live";
    liveAt: number | null;
    participantes: number;
    capacidad: number;
  } | null,
): SalonView {
  if (!datos) {
    return {
      salon,
      estado: "libre",
      clase: "",
      minutos: 0,
      transcurridos: null,
      participantes: 0,
      capacidad: 0,
    };
  }

  const estado: EstadoSalon =
    datos.phase === "editing"
      ? "preparando"
      : datos.participantes >= datos.capacidad
        ? "llena"
        : datos.participantes > 0
          ? "en-curso"
          : "disponible";

  return {
    salon,
    estado,
    clase: datos.clase,
    minutos: datos.minutos,
    transcurridos: datos.liveAt === null ? null : Math.floor((Date.now() - datos.liveAt) / 60000),
    participantes: datos.participantes,
    capacidad: datos.capacidad,
  };
}

/** Si un estudiante puede entrar a un salon en ese estado. */
export function admiteEstudiantes(estado: EstadoSalon) {
  return estado === "disponible" || estado === "en-curso";
}
