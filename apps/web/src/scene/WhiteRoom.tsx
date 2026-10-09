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
  /** La zona donde el imán deja apoyar las piezas. El lobby no tiene. */
  placement,
  showPlacement = false,
  /** Sin entorno 360 la luz la ponen estas lámparas; con él, sobran. */
  lit,
}: {
  halfSize: number;
  spots: SceneSpot[];
  mySpotId: string;
  placement?: { center: [number, number]; half: [number, number] };
  showPlacement?: boolean;
  lit: boolean;
}) {
  // La rejilla es cuadrada y el suelo redondo: a lo ancho completo, sus
  // esquinas se salen del disco y quedan cuatro líneas sueltas flotando sobre
  // el paisaje. El cuadrado inscrito en el círculo es el que cabe entero.
  const size = Math.round(halfSize * 1.41 * 2) / 2;
  const fade = useMemo(() => makeFade(), []);

  return (
    <group>
      {/*
        Luz natural: un sol y un cielo. Dos luces, siempre las mismas.

        Antes eran cuatro con la habitación en blanco -ambiente, hemisférica y
        dos direccionales- y, con un entorno 360 puesto, una ambiente más la
        iluminación del propio paisaje por mapa de entorno. Cada luz entra en
        el shader de cada material iluminado, así que eran dos escenas
        distintas de iluminar y la cara se pagaba justo cuando había un paisaje
        detrás que ya costaba lo suyo.

        Una direccional hace de sol y da el volumen -sin ella una esfera y un
        cilindro del mismo color se ven igual-, y la hemisférica hace de cielo:
        aclara por arriba, oscurece por abajo y evita que las caras en sombra
        queden negras. Eso es una luz ambiental, pero con dirección, y cuesta
        lo mismo.

        La intensidad sí cambia según haya paisaje o no, porque con mapeo de
        tonos ACES la misma luz sale más apagada. Es un número, no una luz más.
      */}
      <hemisphereLight args={["#ffffff", "#9fb0ae", lit ? 1.7 : 2.2]} />
      <directionalLight position={[3, 5, 2]} intensity={lit ? 1 : 1.5} />

      {/*
        No hay sombras en tiempo real, y es deliberado: lo que hace entender
        dónde está una pieza aquí es el imán -que la apoya en la mesa o en el
        piso- y la rejilla del suelo, no una sombra. Un mapa de sombras es una
        pasada entera de la escena por cuadro para algo que ya se resuelve.
      */}

      {/*
        El suelo se desvanece hacia el borde. Con un entorno 360 detrás, un
        disco de canto duro se ve como una tapa blanca pegada encima de la
        foto; difuminado, el salón se apoya en el paisaje en vez de taparlo.
      */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        {/* 48 lados en vez de 64: es un disco plano visto casi de canto. */}
        <circleGeometry args={[halfSize, 48]} />
        {/*
          Lambert y no Standard. El suelo es mate -no tiene brillo especular
          que mostrar- así que todo el aparato PBR se gastaba en calcular un
          reflejo que no se ve. `receiveShadow` también se fue: no hay sombras.
        */}
        <meshLambertMaterial
          color={lit ? "#EDF1F1" : "#C6CFCF"}
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
      {showPlacement && placement && (
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
