/**
 * El entorno 360.
 *
 * La HDRI se monta como una esfera de verdad y no como fondo del render, por
 * dos razones: hay que poder subirla y bajarla para que su horizonte case con
 * el suelo del salón -un fondo no tiene altura-, y hay que poder anclarla al
 * punto medio del escenario para que no siga a la cámara. Gira solo cuando el
 * profesor mueve los deslizadores.
 *
 * La textura llega desde el servidor a 1024x512 y pesa ~1,5 MB: baja al
 * elegir el entorno, no al abrir el carrusel, y hasta que llega se sigue
 * viendo lo que había.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import {
  ACESFilmicToneMapping,
  BackSide,
  EquirectangularReflectionMapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoToneMapping,
  type Group,
  type Texture,
} from "three";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { assetUrl, type Environment } from "../net/api";
import type { AulaRoom } from "../net/room";
import { envPredicted } from "./registry";

export type EnvStatus =
  | { state: "idle" }
  | { state: "loading"; id: string; progress: number }
  | { state: "ready"; id: string }
  | { state: "error"; id: string; message: string };

/**
 * Radio de la esfera.
 *
 * Suficiente para que ni la mesa ni los puestos se acerquen a ella, y bien
 * por dentro del plano lejano de la cámara (60 m): una esfera más grande solo
 * conseguiría desaparecer recortada.
 */
const RADIUS = 20;

export function Environment360({
  room,
  envId,
  catalog,
  onStatus,
}: {
  room: AulaRoom;
  envId: string;
  catalog: Environment[];
  onStatus: (status: EnvStatus) => void;
}) {
  const { scene, gl } = useThree();
  const [texture, setTexture] = useState<Texture | null>(null);
  const sphere = useRef<Group>(null);

  useEffect(() => {
    if (!envId) {
      setTexture(null);
      onStatus({ state: "idle" });
      return;
    }

    const entry = catalog.find((environment) => environment.id === envId);
    if (!entry) {
      onStatus({ state: "error", id: envId, message: "Ese entorno ya no está." });
      return;
    }

    let cancelled = false;
    onStatus({ state: "loading", id: envId, progress: 0 });

    const loader = new HDRLoader();
    loader.load(
      assetUrl(entry.file),
      (loaded: Texture) => {
        if (cancelled) {
          loaded.dispose();
          return;
        }
        loaded.mapping = EquirectangularReflectionMapping;
        // Sin esto three deja el filtrado por defecto para una textura
        // Half/FloatType: sin mipmaps ni anisotropia, la esfera se ve
        // pixelada en los angulos oblicuos aunque la fuente sea nitida.
        loaded.generateMipmaps = true;
        loaded.minFilter = LinearMipmapLinearFilter;
        loaded.magFilter = LinearFilter;
        // Acotada, no al maximo. El maximo de la tarjeta suele ser 16x, y son
        // dieciseis muestras por pixel sobre una textura de coma flotante que
        // ocupa **toda** la pantalla de fondo. En una esfera lejana la
        // diferencia entre 4x y 16x no se ve; el costo si se nota.
        loaded.anisotropy = Math.min(4, gl.capabilities.getMaxAnisotropy());
        setTexture(loaded);
        onStatus({ state: "ready", id: envId });
      },
      (event: ProgressEvent) => {
        if (cancelled || !event.lengthComputable) return;
        onStatus({ state: "loading", id: envId, progress: event.loaded / event.total });
      },
      () => {
        if (!cancelled) {
          onStatus({ state: "error", id: envId, message: "No se pudo cargar el entorno." });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [catalog, envId, onStatus]);

  // La textura anterior se libera al cambiar de entorno: son 2 MB en memoria
  // de vídeo cada una, y con tres cambios seguidos se nota en un celular.
  useEffect(() => {
    return () => {
      texture?.dispose();
    };
  }, [texture]);

  /**
   * El entorno es **fondo, no luz**.
   *
   * Aquí se usaba además como fuente de iluminación: `scene.environment`, con
   * lo que cada material PBR de la escena muestreaba el mapa de entorno en
   * cada píxel. Y no era solo el muestreo: asignar `scene.environment` hace
   * que three genere un **PMREM** -un mapa de entorno prefiltrado, con varias
   * pasadas de desenfoque a textura- cada vez que la foto cambia. Todo eso
   * para iluminar una mesa, tres cubos y unos avatares de colores planos.
   *
   * Ahora la luz la ponen dos luces fijas (ver WhiteRoom) y esta foto solo se
   * ve. El resultado es parecido y el coste por cuadro es otro: sin PMREM, sin
   * muestreos de entorno y sin materiales PBR.
   *
   * El mapeo de tonos sí se queda mientras haya foto, y no es lo mismo: es una
   * cuenta por píxel en el shader, barata, y sin ella un cielo con valores muy
   * por encima de 1 se ve como una mancha blanca. Sin foto se vuelve al render
   * plano, que es lo que mantiene blanca la habitación en blanco.
   */
  useEffect(() => {
    if (texture) {
      gl.toneMapping = ACESFilmicToneMapping;
      gl.toneMappingExposure = 0.78;
    } else {
      gl.toneMapping = NoToneMapping;
      gl.toneMappingExposure = 1;
    }
    return () => {
      gl.toneMapping = NoToneMapping;
      gl.toneMappingExposure = 1;
    };
  }, [gl, texture]);

  // La colocación llega en el estado a 20 Hz mientras el profesor arrastra un
  // control, así que se lee aquí y no por React.
  useFrame(() => {
    const group = sphere.current;
    if (!group) return;
    const rot = envPredicted.rot ?? room.state.envRot;
    group.position.set(
      envPredicted.x ?? room.state.envX,
      envPredicted.y ?? room.state.envY,
      envPredicted.z ?? room.state.envZ,
    );
    group.rotation.set(0, rot, 0);
    group.scale.setScalar(envPredicted.scale ?? room.state.envScale);
    // La luz de la escena sale de la misma foto: si el paisaje gira, la luz
    // gira con él, o el sol acaba saliendo por donde no hay cielo.
    scene.environmentRotation.set(0, rot, 0);
  });

  if (!texture) return null;

  return (
    <group ref={sphere}>
      <mesh raycast={() => null}>
        <sphereGeometry args={[RADIUS, 48, 32]} />
        <meshBasicMaterial map={texture} side={BackSide} />
      </mesh>
    </group>
  );
}
