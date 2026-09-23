import { BackSide } from "three";
import type { SceneSpot } from "../net/api";

/**
 * La habitacion blanca: el punto de partida de todo salon.
 *
 * La rejilla del piso no es decoracion. Con seguimiento por camara la
 * profundidad es lo mas dificil de juzgar, y una referencia regular en el
 * suelo le da al ojo la escala que la mano no alcanza a dar.
 */
export function WhiteRoom({
  halfSize,
  height,
  spots,
  mySpotId,
}: {
  halfSize: number;
  height: number;
  spots: SceneSpot[];
  mySpotId: string;
}) {
  const size = halfSize * 2;

  return (
    <group>
      {/*
        Una habitacion blanca se ilumina casi toda con luz ambiente: es un
        espacio difuso, sin sol. Las direccionales solo aportan lo justo para
        que los objetos tengan volumen; con ellas al mando, las paredes que
        miran en contra quedan grises y el entorno deja de ser blanco.
      */}
      <ambientLight intensity={1.55} />
      <hemisphereLight args={["#ffffff", "#ccd6d5", 1.1]} />
      <directionalLight position={[2.5, 4, 1.5]} intensity={0.9} />
      <directionalLight position={[-3, 2.5, -2]} intensity={0.35} />

      {/* Caja invertida: paredes, piso y techo de una sola malla. */}
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[size, height, size]} />
        <meshStandardMaterial color="#F4F6F6" side={BackSide} roughness={0.96} metalness={0} />
      </mesh>

      <gridHelper
        args={[size, size * 2, "#C4D0CF", "#E2E8E7"]}
        position={[0, 0.003, 0]}
      />

      {spots.map((spot) => (
        <mesh
          key={spot.id}
          position={[spot.pos[0], 0.005, spot.pos[2]]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <ringGeometry args={[0.26, 0.3, 32]} />
          <meshBasicMaterial
            color={spot.id === mySpotId ? "#0B6E67" : "#BFCBCA"}
            transparent
            opacity={spot.id === mySpotId ? 0.9 : 0.5}
          />
        </mesh>
      ))}
    </group>
  );
}
