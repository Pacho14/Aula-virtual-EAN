/**
 * Apuntar dentro del lobby.
 *
 * El lobby no tiene servidor ni objetos que agarrar: solo hay que mirar
 * alrededor y pulsar. Así que esto es lo mismo que hace el jugador local en la
 * sala, sin nada de la sala: girar la cámara con lo que digan los deslizadores
 * y pasarle el rayo al puntero de la interfaz.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { Vector2 } from "three";
import type { InputLayer } from "../input/inputLayer";
import { HOLD_GESTURES } from "../input/types";
import { cursorState, handRay, HandCursor } from "../ui3d/HandCursor";
import { WidgetPointer } from "../ui3d/pointer";
import { exposeWidgetProbe, pointer } from "../ui3d/widgets";
import { cameraRig, nudgeRig, restRig } from "./cameraRig";
import { OwnHands, type OwnHandsHandle } from "./OwnHands";

const ndc = new Vector2();

export function LobbyPointer({
  input,
  /** Hacia dónde mira quien entra: los portales. */
  lookAt,
}: {
  input: InputLayer;
  lookAt: [number, number, number];
}) {
  const { camera, gl } = useThree();
  const widgetPointer = useRef(new WidgetPointer());
  const drag = useRef({ on: false, x: 0, y: 0 });
  const hands = useRef<OwnHandsHandle>(null);

  useEffect(() => {
    const dx = lookAt[0] - camera.position.x;
    const dy = lookAt[1] - camera.position.y;
    const dz = lookAt[2] - camera.position.z;
    restRig(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    exposeWidgetProbe(camera, new Map());
  }, [camera, lookAt]);

  // Mirar alrededor arrastrando, igual que en la sala: escribe en el mismo
  // valor que los deslizadores, no en uno propio.
  useEffect(() => {
    const element = gl.domElement;
    const down = (event: PointerEvent) => {
      if (input.kind !== "camera") return;
      drag.current = { on: true, x: event.clientX, y: event.clientY };
    };
    const move = (event: PointerEvent) => {
      if (!drag.current.on) return;
      nudgeRig(
        -(event.clientX - drag.current.x) * 0.004,
        -(event.clientY - drag.current.y) * 0.004,
      );
      drag.current.x = event.clientX;
      drag.current.y = event.clientY;
    };
    const up = () => {
      drag.current.on = false;
    };
    element.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      element.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [gl, input]);

  useFrame(() => {
    const now = performance.now();
    const frame = input.tick(now);

    camera.rotation.set(
      cameraRig.restPitch + cameraRig.pitch,
      cameraRig.restYaw + cameraRig.yaw,
      0,
      "YXZ",
    );
    camera.updateMatrixWorld();

    const hand = frame.primary;
    if (!hand || cameraRig.handBusy) {
      widgetPointer.current.reset();
      cursorState.visible = false;
      // Las manos se apagan con todo lo demás: una mano dibujada cuando el
      // detector ya no la ve es peor que ninguna.
      hands.current?.update(null, null, camera);
      return;
    }

    // Las propias manos, igual que en el salón. Aquí empieza la experiencia:
    // quien entra ve sus manos desde el primer momento, no desde que escribe
    // el código.
    hands.current?.update(frame.left, frame.right, camera);

    // Aqui se apunta con la punta del indice, no con el centro de la palma:
    // señalar un portal con el dedo es el gesto que la gente hace sola, y en
    // el lobby no hay nada que agarrar, asi que no importa que la punta se
    // desplace al cerrar la mano. Dentro del salon manda la palma, que es lo
    // que no hace saltar la pieza en el instante de tomarla.
    ndc.set(hand.indexNdcX, hand.indexNdcY);
    handRay.setFromCamera(ndc, camera);
    // Una sola regla: cerrar la mano pulsa. `HOLD_GESTURES` dice qué cuenta
    // como cerrada, y pellizco y puño cuentan los dos.
    const onWidget = widgetPointer.current.update(
      handRay,
      now,
      HOLD_GESTURES.has(hand.gesture),
      frame.source === "camera",
    );

    cursorState.visible = true;
    cursorState.distance = onWidget ? pointer.distance : 3.4;
    cursorState.big = onWidget;
    cursorState.dwell = onWidget ? pointer.dwell : 0;
  });

  return (
    <>
      <OwnHands ref={hands} />
      <HandCursor />
    </>
  );
}
