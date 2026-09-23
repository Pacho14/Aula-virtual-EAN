import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import "./styles.css";

// Los fallos asincronos (la camara, el worker, la red) no pasan por la barrera
// de React, asi que se registran aparte en vez de perderse en la consola.
window.addEventListener("unhandledrejection", (event) => {
  console.error("[aula] promesa sin atender:", event.reason);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
