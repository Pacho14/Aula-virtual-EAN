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
        loaded.anisotropy = gl.capabilities.getMaxAnisotropy();
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
   * La luz de la escena sale de la propia HDRI, y con ella entra el mapeo de
   * tonos ACES: sin él, un cielo de atardecer llega con valores muy por
   * encima de 1 y se ve como una mancha blanca. Sin entorno se vuelve al
   * render plano, que es lo que mantiene blanca la habitación en blanco.
   */
  useEffect(() => {
    if (texture) {
      scene.environment = texture;
      // Bajo a proposito. Una HDRI de exterior trae mucha mas luz que un
      // salon, y a intensidad plena las superficies claras se saturan: la
      // mesa queda blanca y las piezas encima dejan de distinguirse de ella.
      scene.environmentIntensity = 0.55;
      gl.toneMapping = ACESFilmicToneMapping;
      gl.toneMappingExposure = 0.78;
    } else {
      scene.environment = null;
      gl.toneMapping = NoToneMapping;
      gl.toneMappingExposure = 1;
    }
    return () => {
      scene.environment = null;
      gl.toneMapping = NoToneMapping;
      gl.toneMappingExposure = 1;
    };
  }, [gl, scene, texture]);

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
