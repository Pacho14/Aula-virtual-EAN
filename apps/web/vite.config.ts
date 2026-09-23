import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // El .env vive en la raiz del monorepo, no en apps/web. Sin esto Vite no lo
  // encuentra y las VITE_* llegan vacias al cliente.
  envDir: resolve(here, "../.."),
  worker: {
    // El worker de MediaPipe usa imports ES.
    format: "es",
  },
  server: {
    // host: true expone Vite en la LAN, que es como se prueba desde el celular
    // sin levantar el tunel.
    host: true,
    port: 5173,
    // Detras de un tunel de Cloudflare el Host llega con el dominio publico y
    // Vite lo rechazaria. Esto es solo para el servidor de desarrollo.
    allowedHosts: true,
  },
  build: {
    outDir: "dist",
    target: "es2022",
    chunkSizeWarningLimit: 1200,
  },
});
