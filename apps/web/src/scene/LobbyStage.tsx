/**
 * El lobby: donde llega el estudiante antes de tener ningún código.
 *
 * Es el mismo espacio de siempre -suelo y rejilla- amueblado de otra manera:
 * tres portales en fila, uno por salón, y al lado la tabla con lo que hay hoy.
 * No es una escena nueva ni una sala de Colyseus: aquí no hay nadie más, así
 * que no hay nada que sincronizar. Lo único que llega del servidor es el
 * estado de los tres salones, y llega preguntando cada pocos segundos.
 *
 * La cámara tampoco se mueve aquí. Los portales quedan al frente y la tabla a
 * la derecha, dentro del recorrido del deslizador horizontal: girar la cabeza
 * es la manera de recorrer el sitio.
 */
import { Canvas } from "@react-three/fiber";
import { NoToneMapping } from "three";
import type { InputLayer } from "../input/inputLayer";
import type { SalonView } from "../net/api";
import { Keypad } from "../ui3d/Keypad";
import { Portal } from "../ui3d/Portal";
import { SalonTable } from "../ui3d/SalonTable";
import { LobbyPointer } from "./LobbyPointer";
import { WhiteRoom } from "./WhiteRoom";

/** Donde se para quien entra. No se mueve de ahí. */
const OJO: [number, number, number] = [0, 1.6, 2.2];
/** Hacia dónde mira al llegar: al centro de lo que hay. */
const MIRADA: [number, number, number] = [0, 1.45, -0.4];

/**
 * Los tres portales y la tabla, repartidos en arco alrededor del ojo.
 *
 * Todo a dos metros y medio y dentro de unos sesenta grados: cabe entero en
 * pantalla sin girar, se lee sin esfuerzo, y girar con el deslizador sirve
 * para mirar con calma, no para encontrar las cosas.
 */
const RADIO = 3.6;
const SITIOS: Array<[number, number, number]> = [
  enArco(-0.37, RADIO, 1.1),
  enArco(-0.1, RADIO, 1.1),
  enArco(0.17, RADIO, 1.1),
];

// La tabla, algo mas cerca que los portales: tiene letra pequena y hay que
// poder leerla sin girar la cabeza hasta el final del recorrido.
const TABLA: [number, number, number] = enArco(0.53, 3.05, 1.42);

/** Un punto en el arco: `angulo` en radianes, positivo hacia la derecha. */
function enArco(angulo: number, radio: number, altura: number): [number, number, number] {
  return [
    OJO[0] + Math.sin(angulo) * radio,
    altura,
    OJO[2] - Math.cos(angulo) * radio,
  ];
}

export function LobbyStage({
  salones,
  input,
  abierto,
  codigo,
  error,
  busy,
  onOpen,
  onDigit,
  onBackspace,
  onSubmit,
  onCancel,
}: {
  salones: SalonView[];
  input: InputLayer;
  /** Salón cuyo teclado está abierto, o null si se ven los portales. */
  abierto: SalonView | null;
  codigo: string;
  error: string | null;
  busy: boolean;
  onOpen: (salon: SalonView) => void;
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <Canvas
      dpr={[1, 1.5]}
      gl={{ antialias: true, powerPreference: "high-performance", toneMapping: NoToneMapping }}
      camera={{ fov: 62, near: 0.05, far: 60, position: OJO }}
    >
      <color attach="background" args={["#EDF1F1"]} />

      <WhiteRoom halfSize={6} spots={[]} mySpotId="" lit />

      {abierto ? (
        <Keypad
          vista={abierto}
          codigo={codigo}
          error={error}
          busy={busy}
          position={[0, 1.45, 0.4]}
          rotation={caraAlOjo([0, 1.45, 0.4])}
          onDigit={onDigit}
          onBackspace={onBackspace}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      ) : (
        <>
          {salones.map((salon, i) => {
            const sitio = SITIOS[i] ?? SITIOS[0]!;
            return (
              <Portal
                key={salon.salon}
                vista={salon}
                position={sitio}
                rotation={caraAlOjo(sitio)}
                onOpen={() => onOpen(salon)}
              />
            );
          })}

          <SalonTable salones={salones} position={TABLA} rotation={caraAlOjo(TABLA)} />
        </>
      )}

      <LobbyPointer input={input} lookAt={MIRADA} />
    </Canvas>
  );
}

/**
 * Giro para que algo plano mire al ojo.
 *
 * Un plano mira a +Z de fábrica; girándolo en Y hacia el observador se lee de
 * frente aunque esté a un lado de la sala, que es lo que hace que una fila de
 * portales en arco no se vea de canto.
 */
function caraAlOjo(pos: [number, number, number]): [number, number, number] {
  return [0, Math.atan2(OJO[0] - pos[0], OJO[2] - pos[2]), 0];
}
