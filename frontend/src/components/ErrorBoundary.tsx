import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary. A thrown exception in any view would otherwise
 * blank the whole app -- worst possible outcome during a live demo. This
 * catches the failure and surfaces it as a recoverable error card.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // eslint-disable-next-line no-console
    console.error("[SPIRE] Error boundary caught:", error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center p-12">
        <div className="max-w-xl rounded border border-[var(--color-danger-muted)] bg-[var(--color-surface)] p-8">
          <h2 className="mb-2 text-lg font-semibold text-[var(--color-danger)]">
            View crashed
          </h2>
          <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
            The active view threw an exception. The rest of SPIRE is unaffected.
          </p>
          <pre className="mb-4 overflow-auto rounded bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
            {this.state.error.message}
          </pre>
          <button
            onClick={this.reset}
            className="rounded border border-[var(--color-border-active)] px-4 py-2 text-sm hover:bg-[var(--color-surface-hover)]"
          >
            Recover
          </button>
        </div>
      </div>
    );
  }
}
