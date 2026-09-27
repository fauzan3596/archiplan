// Catches WebGL context creation failures (r3f rethrows them from <Canvas>)
// and any render error inside the 3D subtree.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

export const WebGLUnavailable = ({ onRetry }: { onRetry?: () => void }) => (
  <div className="canvas-error" role="alert">
    <div className="error-card">
      <AlertTriangle className="icon" />
      <p className="title">WebGL tidak tersedia</p>
      <p className="subtitle">
        Perangkat atau peramban ini tidak dapat menampilkan tampilan 3D. Aktifkan
        akselerasi perangkat keras atau coba peramban lain.
      </p>
      {onRetry && (
        <button type="button" className="btn btn--secondary btn--sm retry" onClick={onRetry}>
          Coba lagi
        </button>
      )}
    </div>
  </div>
);

interface CanvasErrorBoundaryProps {
  children: ReactNode;
}

interface CanvasErrorBoundaryState {
  error: Error | null;
}

// Error boundaries have to be class components.
class CanvasErrorBoundary extends Component<
  CanvasErrorBoundaryProps,
  CanvasErrorBoundaryState
> {
  state: CanvasErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): CanvasErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("3D canvas failed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <WebGLUnavailable onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

export default CanvasErrorBoundary;
