/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Origen de la API. Vacio = se deduce: el mismo origen de la pagina si esta
   * compilada, o el hostname actual con VITE_SERVER_PORT en desarrollo.
   */
  readonly VITE_API_URL?: string;
  /** Puerto del servidor en desarrollo. Por defecto 2567. */
  readonly VITE_SERVER_PORT?: string;
  /** Carpeta con los binarios WASM de MediaPipe. */
  readonly VITE_MEDIAPIPE_WASM?: string;
  /** Modelo hand_landmarker.task. Ponlo local para funcionar sin internet. */
  readonly VITE_HAND_MODEL_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
