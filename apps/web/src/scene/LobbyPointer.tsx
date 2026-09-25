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
import { cursorState, handRay, HandCursor } from "../ui3d/HandCursor";
import { WidgetPointer } from "../ui3d/pointer";
import { exposeWidgetProbe, pointer } from "../ui3d/widgets";
import { cameraRig, nudgeRig, restRig } from "./cameraRig";

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
  const selectPulse = useRef(false);
  const drag = useRef({ on: false, x: 0, y: 0 });

  useEffect(() => {
    const dx = lookAt[0] - camera.position.x;
    const dy = lookAt[1] - camera.position.y;
    const dz = lookAt[2] - camera.position.z;
    restRig(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    exposeWidgetProbe(camera, new Map());
  }, [camera, lookAt]);

  useEffect(() => input.on((action) => {
    if (action === "select") selectPulse.current = true;
  }), [input]);

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
      cursorState.dwell = 0;
      selectPulse.current = false;
      return;
    }

    ndc.set(hand.ndcX, hand.ndcY);
    handRay.setFromCamera(ndc, camera);
    const onWidget = widgetPointer.current.update(
      handRay,
      now,
      hand.gesture === "fist" || hand.gesture === "pinch",
      selectPulse.current,
    );
    selectPulse.current = false;

    cursorState.visible = true;
    cursorState.distance = onWidget ? pointer.distance : 3.4;
    cursorState.big = onWidget;
    cursorState.dwell = onWidget ? pointer.dwell : 0;
  });

  return <HandCursor />;
}
