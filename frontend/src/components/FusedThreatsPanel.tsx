/**
 * FusedThreatsPanel — GC-4 multi-sensor fusion surface.
 *
 * Mounted at the top of the BASTION alert sidebar. Pulls
 * /bastion/fused-threats and renders correlation chains as expandable
 * rows. Each fused threat shows the contributing alert sources in
 * order, the inferred severity (CRITICAL when chain crosses sensor
 * boundaries — e.g. PACS gate event + ThermalHawk UAS), and the auto-
 * generated response taskings.
 */
import { useEffect, useState } from "react";
import { api, type FusedThreat } from "../api";
import { pollWithBackoff } from "../api-retry";
import { useSpireStore } from "../state/store";
import { Pressable } from "./ui";
import { RefreshAge } from "./RefreshAge";

const SEV_COLOR: Record<string, string> = {
  CRITICAL: "var(--color-danger)",
  HIGH: "#fb923c",
  MODERATE: "var(--color-warning)",
  LOW: "var(--color-success)",
  INFO: "var(--color-primary)",
};

export function FusedThreatsPanel({
  initialThreats,
  onSelectFused,
}: {
  initialThreats?: FusedThreat[];
  onSelectFused?: (t: FusedThreat) => void;
}) {
  const role = useSpireStore((s) => s.role);
  const [threats, setThreats] = useState<FusedThreat[]>(initialThreats ?? []);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Wall-clock ms timestamp of the last successful /fused-threats poll.
  // Drives the "Stream last refreshed Nm Ns ago" indicator on the
  // fused-threats card header (findings F6/F9). The poll backs off to
  // 60s when the threat fingerprint is unchanged, so without this
  // stamp a quiet card masks a stale link.
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(
    initialThreats ? Date.now() : null,
  );

  useEffect(() => {
    if (initialThreats && initialThreats.length > 0) {
      setThreats(initialThreats);
      setLastRefreshedAt(Date.now());
      return;
    }
    // Walkthrough audit: 5s setInterval hammered /fused-threats with no
    // backoff, contributing to 502 storms during Fly deploy churn.
    // Switch to pollWithBackoff: 5s base, drops to 60s when nothing
    // changes, retries with backoff on errors.
    const ctrl = pollWithBackoff(() => api.bastion.fusedThreats(), {
      baseMs: 5000,
      maxMs: 60000,
      fingerprint: (r) =>
        (r.fused_threats || []).map((t) => `${t.id}:${t.severity}`).join(","),
      onResult: (r) => {
        setThreats(r.fused_threats || []);
        setLastRefreshedAt(Date.now());
      },
    });
    return () => ctrl.stop();
  }, [initialThreats, role]);

  if (threats.length === 0) {
    // Quiet "all clear" line. The empty-state audit flagged the silent return
    // null as a confidence gap — operators want to see that the fusion engine
    // is up and reporting zero, not nothing-at-all.
    return (
      <div className="mb-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-success)]"
            style={{ boxShadow: "0 0 4px var(--color-success)" }}
            aria-hidden
          />
          <span
            className="font-mono text-xs font-semibold uppercase text-[var(--color-success)] tracking-widest"
          >
            Fused Threats
          </span>
          <span
            className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
          >
            All clear · 0 active correlations
          </span>
        </div>
        {/* Refresh-age stamp on the empty state so the operator can see
         * the fusion engine is reporting "all clear" recently, vs. a
         * stale link parked at zero. */}
        <RefreshAge ts={lastRefreshedAt} className="mt-1" />
      </div>
    );
  }

  return (
    <div className="mb-2 rounded-sm border border-[var(--color-danger-muted)] bg-[color-mix(in_oklab,var(--color-danger-muted)_18%,var(--color-bg))]">
      <div className="border-b border-[var(--color-danger-muted)] px-3 py-1.5">
        <div className="flex items-baseline justify-between">
          <span
            className="font-mono text-xs font-semibold uppercase text-[var(--color-danger)] tracking-widest"
          >
            ◆ Fused Threats
          </span>
          <span
            className="font-mono text-xs tabular-nums text-[var(--color-text-muted)] tracking-wider"
          >
            {threats.length} active
          </span>
        </div>
        {/* Stream-age stamp under the count so the operator can see at
         * a glance whether the active threat list is current truth or
         * a snapshot from a minute ago on a degraded link. */}
        <RefreshAge ts={lastRefreshedAt} className="mt-1" />
      </div>
      <div className="flex flex-col">
        {threats.map((t) => {
          const open = expanded.has(t.id);
          const color = SEV_COLOR[t.severity];
          return (
            <div
              key={t.id}
              className="border-b border-[var(--color-border)] last:border-b-0"
            >
              <Pressable
                onClick={() => {
                  setExpanded((prev) => {
                    const n = new Set(prev);
                    if (n.has(t.id)) n.delete(t.id);
                    else n.add(t.id);
                    return n;
                  });
                  onSelectFused?.(t);
                }}
                className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--color-danger-muted)_30%,transparent)]"
              >
                <span
                  className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{
                    background: color,
                    boxShadow: `0 0 6px ${color}`,
                    animation: t.severity === "CRITICAL" ? "pulse 1.6s ease-in-out infinite" : undefined,
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 font-mono text-xs tracking-wider">
                    <span className="font-semibold uppercase" style={{ color }}>{t.severity}</span>
                    <span className="text-[var(--color-text-muted)]">·</span>
                    <span className="text-[var(--color-text-muted)]">{(t.confidence * 100).toFixed(0)}% confidence</span>
                    <span className="ml-auto text-[var(--color-text-muted)]">{open ? "▾" : "▸"}</span>
                  </div>
                  <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--color-text)] tracking-wide">
                    {t.title}
                  </div>
                  {/* Correlation chain — visible at all times.
                   *
                   * Uses `c.label` when present (e.g. ECP-A, ECP-B from
                   * Multi-Gate fusion) so the operator sees distinct gate
                   * IDs rather than three identical "PACS" pills.
                   * Falls back to source for sensor-typed chains. */}
                  <div className="mt-1 flex flex-wrap items-center gap-1 font-mono text-xs tracking-wider">
                    {t.correlation_chain.map((c, i) => (
                      <span key={i} className="flex items-center gap-1">
                        {i > 0 && <span className="text-[var(--color-text-muted)]">→</span>}
                        <span
                          className="rounded-sm border px-1 py-[1px]"
                          style={{
                            color,
                            borderColor: `color-mix(in oklab, ${color} 40%, var(--color-border))`,
                            background: "color-mix(in oklab, var(--color-bg) 60%, transparent)",
                          }}
                        >
                          {c.label || c.source}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              </Pressable>

              {open && (
                <div className="bg-[var(--color-surface)] px-3 py-2">
                  <div className="text-sm text-[var(--color-text-secondary)]">
                    {t.body}
                  </div>
                  {t.response_taskings.length > 0 && (
                    <div className="mt-2">
                      <div
                        className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
                      >
                        Auto-generated taskings
                      </div>
                      <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs tracking-wide">
                        {t.response_taskings.map((task, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-[var(--color-text-secondary)]">
                            <span className="text-[var(--color-text-muted)]">›</span>
                            <span>{task}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {/* Full chain detail */}
                  <div
                    className="mt-2 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
                  >
                    Correlation chain · {t.correlation_chain.length} contributing alerts
                  </div>
                  <div className="mt-1 flex flex-col gap-0.5 font-mono text-xs">
                    {t.correlation_chain.map((c, i) => (
                      <div key={i} className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1">
                        <span className="text-[var(--color-text)]">{c.source}</span>
                        <span className="mx-1 text-[var(--color-text-muted)]">·</span>
                        <span className="text-[var(--color-text-secondary)]">{c.title}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
