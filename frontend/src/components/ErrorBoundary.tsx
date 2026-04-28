import { Component, type ReactNode } from "react";
import { Button } from "./ui";

interface State {
  error: Error | null;
}

interface Props {
  children: ReactNode;
  /** Fall-back UI density. `view` is for an Outlet-scoped boundary that
   * preserves chrome above; `app` is the outer-most boundary that has to
   * render its own banner. */
  scope?: "view" | "app";
}

/**
 * Error boundary. Two scopes:
 *
 *   scope="view" — wraps only the Outlet so a view crash doesn't take
 *                  out the chrome (TopBar / ClassificationBand /
 *                  StatusFooter / role switcher). The reviewer caught
 *                  the prior single-boundary version blanking the whole
 *                  app on a stale-chunk failure — provably worse than
 *                  the message claimed ("rest of SPIRE is unaffected").
 *   scope="app"  — outer-most safety net. Reached only if the scope=view
 *                  boundary itself errors, or a chrome component throws.
 *
 * Recover button: tries soft state reset first; on a second crash within
 * 30s, escalates to a hard reload (which pulls fresh hashed chunk paths
 * if the underlying issue was stale chunks).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private lastErrorAt: number = 0;

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // eslint-disable-next-line no-console
    console.error("[SPIRE] Error boundary caught:", error, info);
    this.lastErrorAt = Date.now();
  }

  reset = () => {
    // If we crash again within 30s of last reset, escalate to hard reload.
    if (Date.now() - this.lastErrorAt < 30_000) {
      window.location.reload();
      return;
    }
    this.setState({ error: null });
  };

  hardReload = () => window.location.reload();

  render() {
    if (!this.state.error) return this.props.children;

    const msg = this.state.error.message || "Unknown error";
    const isChunkFail = /failed to fetch dynamically imported module|loading chunk \d+ failed/i.test(msg);
    const scope = this.props.scope ?? "view";

    return (
      <div className={scope === "view" ? "flex h-full items-center justify-center p-8" : "flex h-screen items-center justify-center p-12"}>
        <div className="max-w-xl rounded-md border border-[var(--color-danger-muted)] bg-[var(--color-surface)] p-6">
          <div className="mb-2 font-mono text-xs uppercase text-[var(--color-danger)] tracking-widest">
            {isChunkFail ? "Build out of date" : "View crashed"}
          </div>
          <h2 className="mb-2 text-lg font-semibold text-[var(--color-text)]">
            {isChunkFail
              ? "A newer build is live — refresh to load it."
              : "The active view threw an exception."}
          </h2>
          <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
            {isChunkFail
              ? "Your tab is referencing a chunk that was replaced by the latest deploy. Click Reload to fetch the current version. Other views remain available from the navigation bar above."
              : scope === "view"
                ? "The chrome (header, role switcher, classification banner) is still live — you can switch views or roles above."
                : "SPIRE is recovering. Try Reload or use the navigation."}
          </p>
          <pre className="mb-4 max-h-32 overflow-auto rounded-sm bg-[var(--color-bg)] p-3 font-mono text-xs text-[var(--color-text-muted)]">
            {msg}
          </pre>
          <div className="flex items-center gap-2">
            {isChunkFail ? (
              <Button onClick={this.hardReload} variant="primary" size="md">
                Reload
              </Button>
            ) : (
              <>
                <Button onClick={this.reset} variant="secondary" size="md">
                  Try again
                </Button>
                <Button onClick={this.hardReload} variant="primary" size="md">
                  Hard reload
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }
}
