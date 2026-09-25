import { useMemo } from "react";
import { CanvasTexture, DoubleSide, LinearFilter } from "three";
import type { SceneSpot } from "../net/api";

/**
 * El piso del salón.
 *
 * Hasta la fase 1 esto era una caja blanca cerrada. Con entornos 360 las
 * paredes sobran: son ellas las que taparían el paisaje, y un salón que se
 * arma eligiendo un entorno tiene que empezar por el suelo y nada más.
 *
 * La rejilla no es decoración. Con seguimiento por cámara la profundidad es
 * lo más difícil de juzgar, y una referencia regular en el suelo le da al ojo
 * la escala que la mano no alcanza a dar.
 */
export function WhiteRoom({
  halfSize,
  spots,
  mySpotId,
  /** La zona donde el imán deja apoyar las piezas. */
  placement,
  showPlacement,
  /** Sin entorno 360 la luz la ponen estas lámparas; con él, sobran. */
  lit,
}: {
  halfSize: number;
  spots: SceneSpot[];
  mySpotId: string;
  placement: { center: [number, number]; half: [number, number] };
  showPlacement: boolean;
  lit: boolean;
}) {
  // La rejilla es cuadrada y el suelo redondo: a lo ancho completo, sus
  // esquinas se salen del disco y quedan cuatro líneas sueltas flotando sobre
  // el paisaje. El cuadrado inscrito en el círculo es el que cabe entero.
  const size = Math.round(halfSize * 1.41 * 2) / 2;
  const fade = useMemo(() => makeFade(), []);

  return (
    <group>
      {lit ? (
        <>
          {/*
            Un espacio en blanco se ilumina casi todo con luz ambiente: es
            difuso, sin sol. Las direccionales solo aportan lo justo para que
            los objetos tengan volumen.
          */}
          <ambientLight intensity={1.55} />
          <hemisphereLight args={["#ffffff", "#ccd6d5", 1.1]} />
          <directionalLight position={[2.5, 4, 1.5]} intensity={0.9} />
          <directionalLight position={[-3, 2.5, -2]} intensity={0.35} />
        </>
      ) : (
        // Con la HDRI iluminando, una pizca de ambiente nada más: evita que
        // las caras que miran en contra del paisaje queden negras del todo.
        <ambientLight intensity={0.25} />
      )}

      {/*
        El suelo se desvanece hacia el borde. Con un entorno 360 detrás, un
        disco de canto duro se ve como una tapa blanca pegada encima de la
        foto; difuminado, el salón se apoya en el paisaje en vez de taparlo.
      */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <circleGeometry args={[halfSize, 64]} />
        <meshStandardMaterial
          color={lit ? "#EDF1F1" : "#C6CFCF"}
          roughness={0.92}
          metalness={0}
          side={DoubleSide}
          alphaMap={fade}
          transparent
          opacity={lit ? 1 : 0.82}
        />
      </mesh>

      <gridHelper
        args={[size, Math.round(size * 2), "#C4D0CF", "#E2E8E7"]}
        position={[0, 0.003, 0]}
      />

      {/*
        Mientras se arma la escena se dibuja dónde se puede dejar algo. Sin
        esta marca, el profesor descubre el límite soltando una pieza y viendo
        que vuelve sola, que parece un fallo y no una regla.
      */}
      {showPlacement && (
        <mesh
          position={[placement.center[0], 0.006, placement.center[1]]}
          rotation={[-Math.PI / 2, 0, 0]}
          raycast={() => null}
        >
          <planeGeometry args={[placement.half[0] * 2, placement.half[1] * 2]} />
          <meshBasicMaterial color="#12938A" transparent opacity={0.1} />
        </mesh>
      )}

      {spots.map((spot) => (
        <mesh
          key={spot.id}
          position={[spot.pos[0], 0.005, spot.pos[2]]}
          rotation={[-Math.PI / 2, 0, 0]}
          raycast={() => null}
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

/** Máscara radial: opaca en el centro y transparente en el borde del disco. */
function makeFade() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(0.62, "#ffffff");
  gradient.addColorStop(1, "#000000");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);

  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  return texture;
}
