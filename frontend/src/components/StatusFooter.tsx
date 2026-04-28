import { useEffect, useState } from "react";
import { api, type SystemStatus } from "../api";
import { pollWithBackoff } from "../api-retry";
import { useSpireStore } from "../state/store";
import { Pressable } from "./ui";

// Audit hash + classification posture pin to fixed positions in the footer
// so they're always readable. The marquee carries only the rotating
// telemetry. The footer no longer mirrors the classification banner — that
// is now the single canonical mention; here we surface posture + chain
// fingerprint instead.

function formatUptime(startedAt: number): string {
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function StatusFooter() {
  const [now, setNow] = useState(() => new Date());
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [startedAt] = useState(() => Date.now());
  const commsState = useSpireStore((s) => s.commsState);
  const airGap = useSpireStore((s) => s.airGapActive);
  const queueDepth = useSpireStore((s) => s.queueDepth);
  // Task #140 — operator-engaged "SATCOM yellow" drill override. Mirror
  // it into the footer pulse so the bottom indicator agrees with the
  // top StatusStrip Comms chip (otherwise the chrome would say two
  // different things about the same link).
  const commsOverride = useSpireStore((s) => s.commsDegradedOverride);
  const setCommsState = useSpireStore((s) => s.setCommsState);
  const setAirGap = useSpireStore((s) => s.setAirGap);
  const setQueueDepth = useSpireStore((s) => s.setQueueDepth);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // System status — base 15s, backs off to 60s if nothing changes. The
  // marquee labels rarely flip; aggressive polling here was the largest
  // share of the steady-state GET pressure caught in the deep-review.
  useEffect(() => {
    const ctrl = pollWithBackoff(() => api.system.status(), {
      baseMs: 15000,
      maxMs: 60000,
      onResult: (s) => setStatus(s),
    });
    return () => ctrl.stop();
  }, []);

  // Poll comms-state every 4s base — backs off to 60s when state is steady.
  // Drives the StatusFooter pulse colour and keeps the air-gap toggle + queue
  // depth in sync if changes happen outside the TopBar.
  useEffect(() => {
    const ctrl = pollWithBackoff(() => api.system.commsState(), {
      baseMs: 4000,
      maxMs: 60000,
      // Fingerprint on the three fields we actually render — ignore any
      // server-side timestamp jitter so the back-off can take hold.
      fingerprint: (c) =>
        `${c.current_state}|${c.air_gap_active ? 1 : 0}|${c.queued_ops_count}`,
      onResult: (c) => {
        setCommsState(c.current_state);
        setAirGap(c.air_gap_active);
        setQueueDepth(c.queued_ops_count);
      },
    });
    return () => ctrl.stop();
  }, [setCommsState, setAirGap, setQueueDepth]);

  const localTime = now.toLocaleTimeString("en-US", { hour12: false });
  const uptime = formatUptime(startedAt);
  const assets = status?.dataset.assets ?? 0;
  const srs = status?.dataset.srs ?? 0;
  const llmOk = status?.llm.reachable ?? false;
  const llmModel = status?.llm.model ?? "—";
  const errs = status?.dataset.consistency_errors ?? 0;
  // Full fingerprint preserved (no longer slice to 12) — operators copy
  // the whole hash for incident reports. We render a fixed-width 12-char
  // prefix in the chrome but the click-to-copy yields the full string.
  const fingerprintFull = (status?.dataset.fingerprint ?? "").toUpperCase();
  const fingerprint = fingerprintFull.slice(0, 12);

  // Walkthrough audit: chips used to hardcode 'AES-256-GCM', '0 egress',
  // and the model val/params strings. Now they read from the live
  // /system/status payload. When the backend doesn't have torch loaded
  // (sentry_loaded / pulse_loaded false), the model chips read
  // 'rule-based fallback' instead of pretending fake validation values.
  // Walkthrough audit: pre-status-load flash showed 'ENCRYPTION off'
  // (warn) and 'MODE LOCAL'. Distinguish 'status not yet loaded' from
  // 'status loaded with bad value' so the ticker doesn't shout false
  // alarms during the first poll cycle.
  const statusLoaded = status != null;
  const egressAttempts = status?.network_egress?.unapproved_attempts ?? 0;
  const encrypted = status?.security?.encrypted_at_rest;
  const sentryLoaded = status?.models?.sentry_loaded ?? false;
  const pulseLoaded = status?.models?.pulse_loaded ?? false;
  // ThermalHawk has three states: model_loaded > weights_present > sim.
  const thermalLive = (status?.models as any)?.thermalhawk_model_loaded ?? false;
  const thermalWeights = (status?.models as any)?.thermalhawk_weights_present ?? false;
  const thermalSizeMb = (status?.models as any)?.thermalhawk_size_mb;
  const tickerItems: { label: string; value: string; tone?: "ok" | "warn" | "muted" }[] = [
    {
      label: "NETWORK",
      value: !statusLoaded ? "—" : egressAttempts === 0 ? "0 egress" : `${egressAttempts} unauthorised`,
      tone: !statusLoaded ? "muted" : egressAttempts === 0 ? "ok" : "warn",
    },
    {
      label: "ENCRYPTION",
      value: !statusLoaded ? "—" : encrypted ? "AES-256-GCM" : "off",
      tone: !statusLoaded ? "muted" : encrypted ? "ok" : "warn",
    },
    { label: "DATASET", value: `${assets.toLocaleString("en-US")} assets · ${srs.toLocaleString("en-US")} SR`, tone: "muted" },
    { label: "INTEGRITY", value: errs === 0 ? "0 errors" : `${errs} errors`, tone: errs === 0 ? "ok" : "warn" },
    { label: "LLM", value: `${llmModel} · ${llmOk ? "online" : "standby"}`, tone: llmOk ? "ok" : "warn" },
    {
      label: "SENTRY·CLASSIFIER",
      value: sentryLoaded ? "online" : "rule-based fallback",
      tone: sentryLoaded ? "ok" : "muted",
    },
    {
      label: "PULSE·RISK",
      value: pulseLoaded ? "online" : "rule-based fallback",
      tone: pulseLoaded ? "ok" : "muted",
    },
    {
      label: "THERMALHAWK",
      value: thermalLive
        ? `live · Thornveil-licensed${thermalSizeMb ? ` · ${thermalSizeMb}MB` : ""}`
        : thermalWeights
        ? `weights present${thermalSizeMb ? ` (${thermalSizeMb}MB)` : ""} · sim only`
        : "scripted sim",
      tone: thermalLive ? "ok" : thermalWeights ? "ok" : "muted",
    },
  ];

  const toneColor = (tone?: "ok" | "warn" | "muted") =>
    tone === "ok"
      ? "var(--color-success)"
      : tone === "warn"
      ? "var(--color-warning)"
      : "var(--color-text-secondary)";

  // Duplicate track so the marquee animation loops seamlessly.
  const track = [...tickerItems, ...tickerItems];

  return (
    <footer
      role="contentinfo"
      aria-label="System telemetry"
      className="relative h-8 shrink-0 overflow-hidden border-t border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      {/* Left-anchored session block — UP/clock + comms-state pulse + audit
       * hash. Audit hash is fixed-width tabular monospace and click-to-copy
       * (full SHA-256, not the truncated prefix). Reviewer caught the prior
       * mid-truncated `6A49DA70B97B…IFIER v` bleed where the right anchor's
       * tail lapped the audit field at narrow viewports — fixed grid width
       * + overflow-hidden block prevents that entirely. */}
      <div
        className="absolute left-0 top-0 z-10 flex h-full items-center gap-2 border-r border-[var(--color-border)] bg-[var(--color-surface)] pl-3 pr-3 font-mono text-xs tracking-wide"
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-success)]"
          style={{ boxShadow: "0 0 5px var(--color-success)" }}
        />
        <span className="text-[var(--color-text-muted)]">UP</span>
        <span className="tabular-nums text-[var(--color-text)]">{uptime}</span>
        <span className="mx-1 text-[var(--color-border-active)]">│</span>
        <span className="tabular-nums text-[var(--color-text-secondary)]">{localTime}</span>
        <span className="mx-1 text-[var(--color-border-active)]">│</span>
        <CommsIndicator
          state={commsOverride && commsState === "CONNECTED" ? "DEGRADED" : commsState}
          airGap={airGap}
          queueDepth={queueDepth}
        />
        <span className="mx-1 hidden text-[var(--color-border-active)] lg:inline">│</span>
        {/* Walkthrough audit: AUDIT chip showed only the chain
         * fingerprint, never the chain integrity status. The backend
         * already exposes audit_chain_intact; surface it as a
         * green/red dot so an operator can see a broken chain at a
         * glance instead of needing to inspect the system status. */}
        <span
          className="hidden h-1.5 w-1.5 rounded-full lg:inline-block"
          style={{
            background: status?.security?.audit_chain_intact === false
              ? "var(--color-danger)"
              : "var(--color-success)",
            boxShadow: `0 0 4px ${status?.security?.audit_chain_intact === false ? "var(--color-danger)" : "var(--color-success)"}`,
          }}
          title={
            status?.security?.audit_chain_intact === false
              ? "AUDIT CHAIN BROKEN — hash chain failed integrity check"
              : "Audit chain intact"
          }
          aria-hidden
        />
        <span className="hidden uppercase text-[var(--color-text-muted)] tracking-wider lg:inline">AUDIT</span>
        <AuditHash full={fingerprintFull} short={fingerprint} />
      </div>

      {/* Right-anchored version/mode block. Classification posture lives in
       * the top banner (single canonical mention) — this side surfaces only
       * the operating mode + product version. */}
      <div
        className="absolute right-0 top-0 z-10 hidden h-full items-center gap-2 border-l border-[var(--color-border)] bg-[var(--color-surface)] pl-3 pr-3 font-mono text-xs uppercase md:flex tracking-wider"
      >
        {/* Walkthrough audit: a bare "FULL" between AUDIT and the version
         * read as a status flag — operators didn't know it meant the
         * operating mode (full-feature vs lite). Prefix with MODE. */}
        <span className="text-[var(--color-text-muted)]" title="Operating mode (full-feature vs lite)">
          MODE {status?.mode?.toUpperCase() || "—"}
        </span>
        <span className="text-[var(--color-border-active)]">│</span>
        <span
          className="text-[var(--color-text-muted)]"
          title="Designed and built by a team of active-duty Marines, on duty time. See LICENSE.md §0 for full attribution."
        >
          MARINE MADE
        </span>
        <span className="text-[var(--color-border-active)]">│</span>
        <span className="text-[var(--color-brand)]">SPIRE v1.0.0-rc1 · MDM 2026</span>
      </div>

      {/* Walkthrough #JOB-C (review #36 PULSE / #25 SENTRY) — every token
       * gets `whitespace-nowrap` on BOTH the wrapper and the inner label/
       * value spans so the marquee never breaks a token mid-character.
       *
       * Pre-fix: dry-run caught "Gemma 4", "3K para", "8.8K p", "ssets ·",
       * "andby", "INTI", "EN", "CM", "-256-GC" — all consequences of the
       * outer span allowing internal whitespace to wrap when the marquee
       * pushed a token across the fade-edge gradient. The container itself
       * had whitespace-nowrap but the inner spans inherited via display:flex
       * which subtly re-enabled wrapping inside the value text.
       *
       * Scrolling telemetry ticker between the anchors. Padding values are
       * tuned so the ticker doesn't overlap the anchored blocks at any
       * breakpoint. The left anchor grew on lg breakpoints to accommodate
       * the pinned audit hash; the right anchor shrank now that the
       * classification posture is no longer duplicated here. */}
      <div
        className="absolute inset-y-0 left-0 right-0 z-0 overflow-hidden pl-[14rem] pr-3 md:pl-[18rem] md:pr-[14rem] lg:pl-[28rem]"
        // Walkthrough audit: screen readers were reading the duplicated
        // ticker track twice (the second copy is purely visual padding for
        // the marquee loop). aria-hidden on the wrapper mutes both copies
        // for AT — the same data lives in /api/system/status for any
        // operator who needs it accessibly.
        aria-hidden="true"
      >
        <div
          className="ticker flex h-full items-center whitespace-nowrap font-mono text-xs tracking-wider"
        >
          {track.map((item, i) => (
            <span
              key={i}
              className="flex shrink-0 items-center gap-2 whitespace-nowrap px-4"
            >
              <span
                className="whitespace-nowrap uppercase text-[var(--color-text-muted)] tracking-wider"
              >
                {item.label}
              </span>
              <span
                className="whitespace-nowrap tabular-nums"
                style={{ color: toneColor(item.tone) }}
              >
                {item.value}
              </span>
              <span className="whitespace-nowrap pl-4 text-[var(--color-border-active)]">◦</span>
            </span>
          ))}
        </div>
      </div>

      {/* Fade edges so ticker text disappears cleanly into the anchored blocks.
       * Walkthrough #JOB-C — fades match the underlying surface and DO NOT
       * clip the token; tokens may slide under the gradient and emerge on
       * the other side intact. The truncations operators saw were a
       * by-product of value spans wrapping, not the gradient. */}
      <div
        className="pointer-events-none absolute left-[18rem] top-0 z-[5] hidden h-full w-10 md:block lg:left-[28rem]"
        style={{
          background:
            "linear-gradient(90deg, var(--color-surface) 0%, transparent 100%)",
        }}
      />
      <div
        className="pointer-events-none absolute right-[14rem] top-0 z-[5] hidden h-full w-10 md:block"
        style={{
          background:
            "linear-gradient(270deg, var(--color-surface) 0%, transparent 100%)",
        }}
      />
    </footer>
  );
}

// Audit hash chip — fixed-width tabular monospace 12-char prefix with
// click-to-copy. Copies the FULL fingerprint to the clipboard and pushes a
// confirmation toast so the operator sees an acknowledgement. Used in
// incident reporting flows where the chain fingerprint is the artefact.
function AuditHash({ full, short }: { full: string; short: string }) {
  const pushToast = useSpireStore((s) => s.pushToast);
  const display = short || "pending";
  const ready = !!full;

  async function copy(e: React.MouseEvent) {
    e.preventDefault();
    if (!ready) return;
    try {
      await navigator.clipboard.writeText(full);
      pushToast({
        tone: "ok",
        text: `Audit hash copied · ${full.slice(0, 12).toUpperCase()}…`,
        ttlMs: 2500,
      });
    } catch {
      // Fallback — older browsers / locked-down kiosks. Push a warn toast
      // so the operator isn't left wondering why the click did nothing.
      pushToast({ tone: "warn", text: "Clipboard unavailable — long-press to copy manually" });
    }
  }

  return (
    // Pressable normally enforces a 44px minimum, but the StatusFooter is
    // intentionally a 32px-tall information density bar. Override
    // `min-h` to 0 to keep the chip in-line; focus-visible ring + a11y
    // attributes still apply.
    <Pressable
      onClick={copy}
      disabled={!ready}
      block={false}
      title={ready ? `Click to copy full SHA-256 fingerprint · ${full}` : "Audit chain fingerprint pending"}
      aria-label={ready ? "Copy full audit chain fingerprint" : "Audit fingerprint pending"}
      className="hidden !min-h-0 tabular-nums text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:underline focus-visible:underline disabled:cursor-default disabled:opacity-60 lg:inline-block"
      style={{ minWidth: "9ch", textAlign: "left" }}
    >
      {display}
      {ready && (
        <span aria-hidden className="ml-1 text-[var(--color-text-muted)]">⎘</span>
      )}
    </Pressable>
  );
}

// Comms-state pulse — green CONNECTED, amber DEGRADED, red DISCONNECTED.
// Air-gap mode flips to red regardless of timeline + shows queue depth.
function CommsIndicator({
  state,
  airGap,
  queueDepth,
}: {
  state: "CONNECTED" | "DEGRADED" | "DISCONNECTED";
  airGap: boolean;
  queueDepth: number;
}) {
  const effective = airGap ? "DISCONNECTED" : state;
  const colors: Record<string, string> = {
    CONNECTED: "var(--color-success)",
    DEGRADED: "var(--color-warning)",
    DISCONNECTED: "var(--color-danger)",
  };
  const c = colors[effective];
  return (
    <span
      className="flex items-center gap-1.5"
      title={airGap ? "Air-gap mode active — local writes are queued" : `Comms ${effective}`}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{
          background: c,
          boxShadow: `0 0 5px ${c}`,
          animation: effective !== "CONNECTED" ? "pulse 1.6s ease-in-out infinite" : undefined,
        }}
      />
      <span className="text-[var(--color-text-muted)]">COMMS</span>
      <span className="font-semibold uppercase tracking-wider" style={{ color: c }}>
        {airGap ? "AIRGAP" : effective}
      </span>
      {airGap && queueDepth > 0 && (
        <span
          className="ml-1 rounded-sm border px-1 font-mono text-xs tabular-nums tracking-wider"
          style={{
            color: "var(--color-warning)",
            borderColor: "color-mix(in oklab, var(--color-warning) 40%, var(--color-border))",
          }}
        >
          Q:{queueDepth}
        </span>
      )}
    </span>
  );
}
