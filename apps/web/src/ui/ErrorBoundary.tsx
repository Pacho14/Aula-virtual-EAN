import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Barrera de errores.
 *
 * Sin esto, cualquier excepción durante el render desmonta el árbol entero y
 * deja una pantalla negra sin una sola pista. Para una prueba que van a correr
 * estudiantes en sus propios equipos, "no funciona" es un reporte inútil: lo
 * que hace falta es el mensaje, y poder copiarlo.
 */
interface State {
  error: Error | null;
  stack: string;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[aula] error de render:", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? "" });
  }

  override render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    const detail = `${error.name}: ${error.message}\n\n${error.stack ?? ""}\n\nComponentes:${stack}`;

    return (
      <div className="crash">
        <div className="crash-card">
          <p className="eyebrow">Algo se rompió</p>
          <h1>{error.message || "Error desconocido"}</h1>
          <p className="lede">
            La sala se detuvo. Copia el detalle de abajo: es lo que hace falta para
            arreglarlo.
          </p>
          <pre>{detail}</pre>
          <div className="crash-actions">
            <button
              className="ghost"
              type="button"
              onClick={() => navigator.clipboard?.writeText(detail)}
            >
              Copiar detalle
            </button>
            <button className="primary" type="button" onClick={() => location.reload()}>
              Recargar
            </button>
          </div>
        </div>
      </div>
    );
  }
}
