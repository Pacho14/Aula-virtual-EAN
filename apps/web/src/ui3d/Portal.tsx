/**
 * Un portal del lobby.
 *
 * La idea es la de cualquier juego con portales: una puerta a un sitio, que
 * desde fuera ya dice si se puede pasar. Aquí no se cruza caminando -la
 * cámara no se mueve de su sitio- sino apuntándole, y el portal responde
 * abriendo el teclado del código.
 *
 * El color y el rótulo dicen el estado sin tener que leer la tabla: verde es
 * pasar, ámbar es esperar, gris es que ahí no hay nada.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { DoubleSide, PlaneGeometry, type Mesh, type MeshBasicMaterial } from "three";
import { admiteEstudiantes, ESTADO_TEXTO, type SalonView } from "../net/api";
import { Button3D } from "./parts";
import { INK, label, makeSheet, paint, roundedRect, UI_ORDER } from "./surface";
import { pointer } from "./widgets";

/**
 * Medidas del portal.
 *
 * Estrecho y alto, como una puerta. Tres puertas y una tabla tienen que caber
 * a la vez en el cuadro sin pisarse: cada centimetro de ancho de mas aqui son
 * dos grados menos de sitio para lo demas.
 */
const ANCHO = 0.95;
const ALTO = 1.55;

/** Un color por estado. El mismo que usa la tabla, para que se reconozcan. */
export const COLOR_ESTADO: Record<SalonView["estado"], string> = {
  libre: "#4A5A6B",
  preparando: "#B4531A",
  disponible: "#12938A",
  "en-curso": "#0F8C9E",
  llena: "#A32A20",
};

export function Portal({
  vista,
  position,
  rotation,
  onOpen,
}: {
  vista: SalonView;
  position: [number, number, number];
  rotation: [number, number, number];
  onOpen: () => void;
}) {
  const superficie = useRef<Mesh>(null);
  const color = COLOR_ESTADO[vista.estado];
  const abierto = admiteEstudiantes(vista.estado);
  const id = `portal-${vista.salon}`;

  const rotulo = useMemo(() => makeSheet(ANCHO, 0.56), []);
  // El marco se dibuja como los bordes de un rectangulo: una linea limpia sin
  // cuatro planos finos que luego se desalinean.
  const marco = useMemo(() => new PlaneGeometry(ANCHO, ALTO), []);
  useEffect(() => {
    paint(rotulo, (ctx, w, h) => {
      roundedRect(ctx, 2, 2, w - 4, h - 4, 20);
      ctx.fillStyle = "rgba(14, 24, 25, 0.9)";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();

      label(ctx, `SALÓN ${vista.salon}`, w / 2, 52, {
        size: 52,
        align: "center",
        weight: 700,
      });
      label(ctx, ESTADO_TEXTO[vista.estado].toUpperCase(), w / 2, 116, {
        size: 30,
        align: "center",
        color,
        weight: 700,
      });
      label(ctx, vista.clase || "Sin clase abierta", w / 2, 164, {
        size: 32,
        align: "center",
        color: vista.clase ? INK.text : INK.dim,
      });
    });
  }, [color, rotulo, vista.clase, vista.estado, vista.salon]);

  // La superficie del portal respira. Quieta parece una pared pintada; con un
  // latido lento se lee como una puerta, que es lo que es.
  useFrame(({ clock }) => {
    const mesh = superficie.current;
    if (!mesh) return;
    const material = mesh.material as MeshBasicMaterial;
    const base = abierto ? 0.42 : 0.18;
    const latido = abierto ? 0.1 : 0.03;
    const resaltado = pointer.hoveredId === id ? 0.14 : 0;
    material.opacity = base + Math.sin(clock.elapsedTime * 1.6) * latido + resaltado;
  });

  return (
    <group position={position} rotation={rotation}>
      {/* La superficie: lo que se ve "al otro lado". */}
      <mesh ref={superficie} raycast={() => null} renderOrder={UI_ORDER.art}>
        <planeGeometry args={[ANCHO - 0.12, ALTO - 0.12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.4}
          depthWrite={false}
          toneMapped={false}
          side={DoubleSide}
        />
      </mesh>

      {/* El marco. */}
      <mesh position={[0, 0, -0.01]} raycast={() => null}>
        <planeGeometry args={[ANCHO, ALTO]} />
        <meshBasicMaterial color="#0E1819" transparent opacity={0.9} toneMapped={false} />
      </mesh>
      <lineSegments position={[0, 0, 0.002]} raycast={() => null}>
        <edgesGeometry args={[marco]} />
        <lineBasicMaterial color={color} toneMapped={false} />
      </lineSegments>

      <group position={[0, ALTO / 2 + 0.36, 0.01]}>
        <mesh raycast={() => null} renderOrder={UI_ORDER.text}>
          <planeGeometry args={[ANCHO, 0.56]} />
          <meshBasicMaterial
            map={rotulo.texture}
            transparent
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      </group>

      {/*
        El portal entero es el blanco: apuntarle a una puerta de metro y medio
        es mucho más fácil que acertarle a un botón pequeño con la mano en el
        aire. El botón dibujado abajo solo dice qué va a pasar al pulsarlo.
      */}
      <Button3D
        id={id}
        position={[0, -ALTO / 2 + 0.24, 0.02]}
        width={ANCHO - 0.26}
        height={0.24}
        tone={abierto ? "primary" : "normal"}
        text={abierto ? "Escribir el código" : "No se puede entrar"}
        disabled={!abierto}
        onActivate={onOpen}
      />
    </group>
  );
}
