/**
 * StatusStrip — the headline-numbers band that sits between the TopBar
 * and the active view.
 *
 * Operators were entering the COP and scanning four corners of the chrome
 * for the things that matter on first glance: overall MC%, FPCON,
 * comms posture, open alert count. The strip aggregates those into a
 * single horizontal row plus an embedded mission-context summary
 * (objective + CCIR + status). Each chip is keyboard-actionable and
 * navigates / scrolls to the relevant deeper surface.
 *
 * Constraints:
 *  - Read-only across roles: every operator sees the same situational
 *    summary regardless of scope. Routing actions still respect scope.
 *  - Plays nicely with density toggle: in sparse mode we let the chips
 *    breathe; in dense mode we compact to fit.
 *  - Mission context is expandable on click; collapses to a one-line
 *    objective summary by default to keep the strip a single row.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { api, type DatasetInfo } from "../api";
import { isPermissionDenied, pollWithBackoff } from "../api-retry";
import { useSpireStore } from "../state/store";
import { Pressable } from "./ui";

const FPCON_TONE: Record<string, { fg: string; bg: string }> = {
  NORMAL:  { fg: "var(--color-success)", bg: "color-mix(in oklab, var(--color-success-muted) 25%, var(--color-bg))" },
  ALPHA:   { fg: "var(--color-success)", bg: "color-mix(in oklab, var(--color-success-muted) 25%, var(--color-bg))" },
  BRAVO:   { fg: "var(--color-selected)", bg: "color-mix(in oklab, var(--color-selected) 14%, var(--color-bg))" },
  CHARLIE: { fg: "var(--color-warning)", bg: "color-mix(in oklab, var(--color-warning-muted) 30%, var(--color-bg))" },
  DELTA:   { fg: "var(--color-danger)",  bg: "color-mix(in oklab, var(--color-danger-muted) 35%, var(--color-bg))" },
};

export function StatusStrip() {
  const nav = useNavigate();
  const fpcon = useSpireStore((s) => s.fpcon);
  const commsState = useSpireStore((s) => s.commsState);
  const airGap = useSpireStore((s) => s.airGapActive);
  // Task #140 — operator/presenter override that forces the comms chip
  // (and any RefreshAge consumer that tightens on a yellow link) to
  // read DEGRADED on top of whatever the backend timeline says. The
  // chip below renders an extra "drill" badge so the operator knows
  // the yellow they're seeing was hand-engaged, not telemetry.
  const commsOverride = useSpireStore((s) => s.commsDegradedOverride);
  const alertCount = useSpireStore((s) => s.alertCount);
  const setAlertCount = useSpireStore((s) => s.setAlertCount);

  const [overallMc, setOverallMc] = useState<number | null>(null);
  const [highCount, setHighCount] = useState<number>(0);
  const [missionOpen, setMissionOpen] = useState<boolean>(false);
  // Walkthrough #JOB-E (review #51 PULSE) — small "?" popover next to the
  // Overall MC chip explains "Strict MC = readiness_code == MC. PMC is
  // partial, NOT MC." Operators were asking which definition each surface
  // used; this is the single source of truth pinned to the chrome.
  const [mcHelpOpen, setMcHelpOpen] = useState<boolean>(false);
  const [datasetInfo, setDatasetInfo] = useState<DatasetInfo | null>(null);

  // Pull fleet MC + alert mix on a 30s/120s back-off cadence. Strip values
  // change slowly during steady-state operations; aggressive polling here
  // would be redundant with the per-view polls already running.
  //
  // Task #196 — split pulse and bastion into independent pollers so a
  // permission-denied response on one (e.g. security_manager hitting
  // /pulse/fleet-overview) lets `pollWithBackoff` stop that side
  // permanently without taking down the other. Previously both calls
  // shared a single tick wrapped in `.catch(() => null)`, which both
  // (a) hid the 403 from `pollWithBackoff` so it kept ticking every
  // 30s and (b) re-issued the network call each tick — producing the
  // 11+ "Failed to load resource: 403" lines per page load that
  // originally motivated this task. Each poll's first tick still
  // hits the wire so backend `require_view_scope` audits the denial
  // (Done criterion #3), then `pollWithBackoff` stops on the 403.
  useEffect(() => {
    const ctrl = pollWithBackoff(
      () => api.pulse.fleetOverview(),
      {
        baseMs: 30000,
        maxMs: 120000,
        fingerprint: (overview) =>
          `${overview?.hero_metrics.fleet_mc_rate.toFixed(3) ?? "-1"}`,
        onResult: (overview) => {
          if (overview) setOverallMc(overview.hero_metrics.fleet_mc_rate);
        },
        onError: (err) => {
          // Silent on permission-denied — the role gate is doing its
          // job and the poller is now stopped (see pollWithBackoff).
          // Other errors (5xx, network) still warn so a real backend
          // outage isn't hidden behind the same code path.
          if (isPermissionDenied(err)) return;
          console.warn("StatusStrip fleet overview unavailable:", err);
        },
      },
    );
    return () => ctrl.stop();
  }, []);

  useEffect(() => {
    const ctrl = pollWithBackoff(
      () => api.bastion.alerts(40),
      {
        baseMs: 30000,
        maxMs: 120000,
        fingerprint: (alerts) => {
          const high = (alerts?.alerts ?? []).filter(
            (a) => a.severity === "HIGH" || a.severity === "CRITICAL",
          ).length;
          const total = alerts?.alerts.length ?? -1;
          return `${total}|${high}`;
        },
        onResult: (alerts) => {
          if (!alerts) return;
          setAlertCount(alerts.alerts.length);
          setHighCount(
            alerts.alerts.filter(
              (a) => a.severity === "HIGH" || a.severity === "CRITICAL",
            ).length,
          );
        },
        onError: (err) => {
          if (isPermissionDenied(err)) return;
          console.warn("StatusStrip alerts unavailable:", err);
        },
      },
    );
    return () => ctrl.stop();
  }, [setAlertCount]);

  // Walkthrough #JOB-E — fetch dataset info once for the help popover.
  // Cheap, low-traffic; no need for backoff polling here.
  useEffect(() => {
    let alive = true;
    api.system
      .datasetInfo()
      .then((d) => {
        if (alive) setDatasetInfo(d);
      })
      .catch(() => {
        /* tolerant — popover renders without the timestamp */
      });
    return () => {
      alive = false;
    };
  }, []);

  // MC% tone — reused thresholds from PULSE.
  const mcTone =
    overallMc == null ? "var(--color-text-muted)"
    : overallMc >= 0.75 ? "var(--color-success)"
    : overallMc >= 0.65 ? "var(--color-warning)"
    : "var(--color-danger)";

  // Effective comms posture for the chip. Air-gap wins (operator-engaged
  // server-side). Then the live timeline — if it's already saying
  // DEGRADED or DISCONNECTED, the override never *downgrades* the
  // posture (we don't want a presenter drill masking a real outage).
  // The override only PROMOTES a green link to yellow for the demo.
  // Code review #140 — same precedence as StatusFooter so the top chip
  // and the bottom indicator never disagree.
  const commsEffective = airGap
    ? "AIRGAP"
    : commsOverride && commsState === "CONNECTED"
      ? "DEGRADED"
      : commsState;
  const commsTone =
    commsEffective === "CONNECTED" ? "var(--color-success)"
    : commsEffective === "DEGRADED" ? "var(--color-warning)"
    : "var(--color-danger)";
  // Task #140 — operator-copy label. Operators on the floor recognise
  // "SATCOM yellow" as the link-degraded ground truth call; the older
  // bare "DEGRADED" pill read as vendor jargon and didn't tell the
  // operator *what* was degraded. Same tone as the recency stamp on
  // the alert sidebar / fused-threats card so the chrome speaks one
  // language about a yellow link.
  const commsValueLabel =
    commsEffective === "AIRGAP"   ? "AIRGAP"
    : commsEffective === "DEGRADED"  ? "SATCOM yellow"
    : commsEffective === "DISCONNECTED" ? "Link down"
    : "Link green";

  const fp = FPCON_TONE[fpcon] ?? FPCON_TONE.BRAVO;

  // Alert chip tone scales by HIGH/CRITICAL count, not total — operators
  // told us "30 alerts" doesn't say anything until you know the mix.
  const alertTone =
    highCount >= 3 ? "var(--color-danger)"
    : highCount >= 1 ? "var(--color-warning)"
    : alertCount === 0 ? "var(--color-text-muted)"
    : "var(--color-success)";

  const mcDisplay = overallMc == null ? "—" : `${(overallMc * 100).toFixed(1)}%`;

  // Task #185 — at <lg viewports the four headline chips + mission
  // pressable wrap onto two rows on most laptops, eating into the
  // active-view canvas. Collapse to a single summary chip ("MC ·
  // FPCON · alerts") that opens the full chip set as a click-to-expand
  // overlay below the strip — no layout push, dismissible by clicking
  // the chip again.
  const [viewportLg, setViewportLg] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try { return window.matchMedia("(min-width: 1024px)").matches; }
    catch { return true; }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setViewportLg(mql.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);
  const [summaryOverlayOpen, setSummaryOverlayOpen] = useState(false);
  // Auto-close the overlay if the operator widens past lg — the full
  // chip row is back in flow, the overlay is now redundant.
  useEffect(() => {
    if (viewportLg && summaryOverlayOpen) setSummaryOverlayOpen(false);
  }, [viewportLg, summaryOverlayOpen]);

  return (
    <div
      role="region"
      aria-label="Mission status summary"
      className="relative shrink-0 border-b border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_92%,var(--color-bg))]"
    >
      {!viewportLg ? (
        // <lg compact mode: a single summary chip that opens an overlay
        // beneath the strip. Mission context still gets its own chip
        // (truncated) so the operator never loses the objective.
        <div className="flex items-center gap-2 px-4 py-1.5">
          <Pressable
            onClick={() => setSummaryOverlayOpen((v) => !v)}
            block={false}
            aria-expanded={summaryOverlayOpen}
            aria-controls="status-strip-summary-overlay"
            aria-label={`Status summary — MC ${mcDisplay}, FPCON ${fpcon}, comms ${commsEffective.toLowerCase()}, ${alertCount} alerts (${highCount} high). Click to expand.`}
            title="Click to expand the full status chip set"
            className="!min-h-0 flex shrink-0 items-center gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-[3px] font-mono text-xs leading-none text-[var(--color-text)] hover:border-[var(--color-border-active)]"
          >
            <span className="font-semibold uppercase tracking-widest text-[var(--color-text-secondary)]">Status</span>
            <span className="tabular-nums" style={{ color: mcTone }}>{mcDisplay}</span>
            <span className="text-[var(--color-text-muted)]">·</span>
            <span style={{ color: fp.fg }}>{fpcon}</span>
            <span className="text-[var(--color-text-muted)]">·</span>
            <span style={{ color: commsTone }}>{commsEffective}</span>
            <span className="text-[var(--color-text-muted)]">·</span>
            <span className="tabular-nums" style={{ color: alertTone }}>
              {alertCount}
              {highCount > 0 && (
                <span
                  className="ml-1 rounded-sm border px-1 text-[10px] font-semibold tabular-nums tracking-widest"
                  style={{
                    color: "var(--color-danger)",
                    borderColor: "color-mix(in oklab, var(--color-danger) 50%, var(--color-border))",
                  }}
                >
                  {highCount} HIGH
                </span>
              )}
            </span>
            <span aria-hidden className="text-[var(--color-text-muted)]">
              {summaryOverlayOpen ? "▴" : "▾"}
            </span>
          </Pressable>
          <Pressable
            onClick={() => setMissionOpen((v) => !v)}
            block={false}
            aria-expanded={missionOpen}
            aria-controls="status-strip-mission-detail"
            className="!min-h-0 ml-auto flex min-w-0 items-center gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-[3px] font-mono text-xs text-[var(--color-text)] hover:border-[var(--color-border-active)] tracking-wide"
            title={`${datasetInfo?.installation_name ?? "Camp Henderson"} mission summary`}
          >
            <span className="truncate">
              <span className="font-semibold uppercase tracking-widest text-[var(--color-text-secondary)]">
                {datasetInfo?.mission_essential_task ?? "BASE DEFENSE / FORCE PROTECTION"}{" "}
              </span>
              <span className="ml-2 text-[var(--color-text-muted)]">
                {datasetInfo?.installation_name ?? "Camp Henderson"}
              </span>
            </span>
            <span aria-hidden className="text-[var(--color-text-muted)]">
              {missionOpen ? "▴" : "▾"}
            </span>
          </Pressable>
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-2 px-4 py-1.5">
        <div className="relative flex items-center">
          <Chip
            label="Overall MC"
            value={mcDisplay}
            tone={mcTone}
            onClick={() => nav("/pulse/overview")}
            ariaLabel={`Overall mission capable rate ${mcDisplay}. Click to open Pulse fleet overview.`}
            title={`Mission-capable rate across ${datasetInfo?.parent_command ?? "2d MLG"} · click to open PULSE Fleet Overview`}
          />
          {/* Walkthrough #JOB-E (review #51 PULSE) — discoverable "?" that
           * pops the methodology card. Operators don't need it most of the
           * time but want it answered without a doc-hunt when they do. */}
          <McMethodologyHelp
            open={mcHelpOpen}
            onToggle={() => setMcHelpOpen((v) => !v)}
            onClose={() => setMcHelpOpen(false)}
            datasetLastDay={datasetInfo?.dataset_last_day ?? null}
          />
        </div>
        <Chip
          label="FPCON"
          value={fpcon}
          tone={fp.fg}
          background={fp.bg}
          onClick={() => nav("/bastion")}
          ariaLabel={`Force protection condition ${fpcon}. Click to open BASTION.`}
          title="Force-protection condition · click to open BASTION"
        />
        <Chip
          label="Comms"
          value={
            <span className="flex items-center gap-1.5">
              {/* Pulsing dot on a yellow / down link so the chip catches
               * peripheral vision the same way the recency stamp does
               * once it crosses its amber threshold. Steady when CONNECTED. */}
              <span
                aria-hidden
                className={clsx(
                  "inline-block h-1.5 w-1.5 rounded-full",
                  commsEffective !== "CONNECTED" && "animate-pulse",
                )}
                style={{ background: commsTone, boxShadow: `0 0 4px ${commsTone}` }}
              />
              <span>{commsValueLabel}</span>
              {commsOverride && !airGap && (
                <span
                  className="rounded-sm border px-1 font-mono text-[10px] uppercase tracking-widest"
                  style={{
                    color: "var(--color-text-muted)",
                    borderColor: "color-mix(in oklab, var(--color-warning) 50%, var(--color-border))",
                  }}
                  title="Drill — yellow indicator engaged from the stage hotkey, not the live timeline"
                >
                  drill
                </span>
              )}
            </span>
          }
          tone={commsTone}
          onClick={() => {
            // No dedicated comms view; tooltip explains and click jumps to
            // BASTION where the AIR-GAP toggle + queue chip live.
            nav("/bastion");
          }}
          ariaLabel={
            airGap
              ? "Air-gap mode engaged — local writes are being queued. Click to open BASTION."
              : commsEffective === "DEGRADED"
                ? `SATCOM yellow${commsOverride ? " (drill)" : ""} — link degraded; alert recency stamps tighten while engaged. Click to open BASTION.`
                : commsEffective === "DISCONNECTED"
                  ? "Comms link down — click to open BASTION."
                  : "Comms link green — click to open BASTION."
          }
          title={
            airGap
              ? "Air-gap mode engaged — local writes queued · open BASTION to release"
              : commsEffective === "DEGRADED"
                ? `SATCOM yellow${commsOverride ? " · drill (engaged via g·y)" : " · live timeline"} — recency stamps tighten to 15s amber / 45s red while the link is yellow`
                : commsEffective === "DISCONNECTED"
                  ? "Comms link down — alert + telemetry feeds may be stalled"
                  : "Comms link green"
          }
        />
        <Chip
          label="Alerts"
          value={
            <span>
              <span className="tabular-nums">{alertCount}</span>
              {highCount > 0 && (
                <span
                  className="ml-1.5 rounded-sm border px-1 text-[10px] font-semibold tabular-nums tracking-widest"
                  style={{
                    color: "var(--color-danger)",
                    borderColor: "color-mix(in oklab, var(--color-danger) 50%, var(--color-border))",
                  }}
                >
                  {highCount} HIGH
                </span>
              )}
            </span>
          }
          tone={alertTone}
          onClick={() => nav("/bastion")}
          ariaLabel={`${alertCount} active alerts, ${highCount} high severity. Click to open BASTION alert stream.`}
          title="Open alert count · click to open BASTION alert stream"
        />

        {/* Mission context: collapses to a single-line objective. Click to
         * expand the full CCIR row inline. Sits flush right so the chip
         * row stays the visual anchor. */}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <span
            className="hidden font-mono uppercase text-[var(--color-text-muted)] md:inline"
            style={{ fontSize: "10px", letterSpacing: "var(--tracking-widest)" }}
          >
            Mission
          </span>
          <Pressable
            onClick={() => setMissionOpen((v) => !v)}
            block={false}
            aria-expanded={missionOpen}
            aria-controls="status-strip-mission-detail"
            className="!min-h-0 flex min-w-0 items-center gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-[3px] font-mono text-xs text-[var(--color-text)] transition-colors hover:border-[var(--color-border-active)] tracking-wide"
            title={`${datasetInfo?.installation_name ?? "Camp Henderson"} mission summary · click to expand CCIR + status`}
          >
            {/* Walkthrough audit: trailing space inside the bold span so
             * screen readers + .innerText don't concatenate "PROTECTIONCamp"
             * (the previous ml-2 gave only visual separation, no character
             * boundary). */}
            <span className="truncate">
              <span className="font-semibold uppercase tracking-widest text-[var(--color-text-secondary)]">
                {datasetInfo?.mission_essential_task ?? "BASE DEFENSE / FORCE PROTECTION"}{" "}
              </span>
              <span className="ml-2 text-[var(--color-text-muted)]">
                {datasetInfo?.installation_name ?? "Camp Henderson"} · {datasetInfo?.parent_command ?? "2d MLG"}
              </span>
            </span>
            <span aria-hidden className="text-[var(--color-text-muted)]">
              {missionOpen ? "▴" : "▾"}
            </span>
          </Pressable>
        </div>
      </div>
      )}

      {summaryOverlayOpen && !viewportLg && (
        // Overlay panel — absolute so it doesn't push the active view
        // canvas. Width spans the full strip so each chip keeps the
        // same "first-glance scan" layout the operator already knows
        // from wider viewports; click the summary chip again or
        // anywhere on the underlying view to dismiss.
        <div
          id="status-strip-summary-overlay"
          role="dialog"
          aria-label="Status chip set (overlay)"
          className="absolute inset-x-0 top-full z-30 flex flex-wrap items-center gap-2 border-b border-[var(--color-border-active)] bg-[color-mix(in_oklab,var(--color-surface)_92%,var(--color-bg))] px-4 py-2 shadow-2xl"
        >
          <Chip
            label="Overall MC"
            value={mcDisplay}
            tone={mcTone}
            onClick={() => { setSummaryOverlayOpen(false); nav("/pulse/overview"); }}
            ariaLabel={`Overall mission capable rate ${mcDisplay}.`}
            title={`Mission-capable rate · click to open PULSE Fleet Overview`}
          />
          <Chip
            label="FPCON"
            value={fpcon}
            tone={fp.fg}
            background={fp.bg}
            onClick={() => { setSummaryOverlayOpen(false); nav("/bastion"); }}
            ariaLabel={`Force protection condition ${fpcon}.`}
            title="Force-protection condition · click to open BASTION"
          />
          <Chip
            label="Comms"
            value={commsEffective}
            tone={commsTone}
            onClick={() => { setSummaryOverlayOpen(false); nav("/bastion"); }}
            ariaLabel={`Communications ${commsEffective.toLowerCase()}.`}
            title={airGap ? "Air-gap mode engaged" : `Comms ${commsEffective.toLowerCase()}`}
          />
          <Chip
            label="Alerts"
            value={
              <span>
                <span className="tabular-nums">{alertCount}</span>
                {highCount > 0 && (
                  <span
                    className="ml-1.5 rounded-sm border px-1 text-[10px] font-semibold tabular-nums tracking-widest"
                    style={{
                      color: "var(--color-danger)",
                      borderColor: "color-mix(in oklab, var(--color-danger) 50%, var(--color-border))",
                    }}
                  >
                    {highCount} HIGH
                  </span>
                )}
              </span>
            }
            tone={alertTone}
            onClick={() => { setSummaryOverlayOpen(false); nav("/bastion"); }}
            ariaLabel={`${alertCount} active alerts, ${highCount} high severity.`}
            title="Open alert count · click to open BASTION alert stream"
          />
        </div>
      )}

      {missionOpen && (
        <div
          id="status-strip-mission-detail"
          className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2"
        >
          <MissionContextDetail datasetInfo={datasetInfo} overallMc={overallMc} highCount={highCount} />
        </div>
      )}
    </div>
  );
}

function Chip({
  label,
  value,
  tone,
  background,
  onClick,
  title,
  ariaLabel,
}: {
  label: string;
  value: React.ReactNode;
  tone: string;
  background?: string;
  onClick?: () => void;
  title?: string;
  ariaLabel?: string;
}) {
  const interactive = !!onClick;
  return (
    <Pressable
      onClick={onClick}
      block={false}
      title={title}
      aria-label={ariaLabel}
      disabled={!interactive}
      className="!min-h-0 flex shrink-0 items-center gap-2 rounded-sm border px-2.5 py-[3px] font-mono text-xs leading-none transition-colors disabled:cursor-default"
      style={{
        borderColor: `color-mix(in oklab, ${tone} 40%, var(--color-border))`,
        background: background ?? "var(--color-surface)",
        color: tone,
        letterSpacing: "var(--tracking-wide)",
      }}
    >
      <span
        className="font-mono uppercase text-[var(--color-text-muted)]"
        style={{ fontSize: "10px", letterSpacing: "var(--tracking-widest)" }}
      >
        {label}
      </span>
      <span className="font-semibold tabular-nums" style={{ color: tone }}>
        {value}
      </span>
    </Pressable>
  );
}

// CCIR + objective + status — the missing situational anchor. Reads
// objective + ccir templates from /api/system/dataset-info, which sources
// them from installation_data.json. {parent} and {installation} are
// substituted server-side so the displayed text is honest and editable
// in data, not in code.
function MissionContextDetail({
  datasetInfo,
  overallMc,
  highCount,
}: {
  datasetInfo: DatasetInfo | null;
  overallMc: number | null;
  highCount: number;
}) {
  const objective = datasetInfo?.mission_objective
    ?? "Sustain readiness; defend the installation; preserve QRF responsiveness.";
  const ccir = datasetInfo?.ccir ?? [];
  // Walkthrough audit: the prior 'Status: Nominal' was a literal string
  // regardless of fleet state. With overall MC at 69.9% and a live HIGH
  // alert open, the CCIR was actually NOT being met. Derive status from
  // the live fleet MC + open HIGH alert count so the chip reconciles
  // with the metrics one row above.
  const mcOk = overallMc != null ? overallMc >= 0.70 : null;
  const highOk = highCount === 0;
  const allOk = mcOk === true && highOk;
  const someAttention = mcOk === false || !highOk;
  const tone = allOk ? "var(--color-success)" : someAttention ? "var(--color-warning)" : "var(--color-text-muted)";
  const label = allOk ? "Nominal" : someAttention ? "Attention" : "Loading";
  const reasons: string[] = [];
  if (mcOk === false) reasons.push(`MC ${(overallMc! * 100).toFixed(1)}% under 70% floor`);
  if (highCount > 0) reasons.push(`${highCount} HIGH alert${highCount === 1 ? "" : "s"} open`);
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <Field label="Objective" body={objective} />
      <Field
        label="CCIR"
        body={
          ccir.length === 0 ? (
            <span className="text-[var(--color-text-muted)]">— pending —</span>
          ) : (
            <ul className="m-0 list-none p-0 leading-snug">
              {ccir.map((c, i) => (
                <li key={i}>· {c}</li>
              ))}
            </ul>
          )
        }
      />
      <Field
        label="Status"
        body={
          <span>
            <span className="font-semibold" style={{ color: tone }}>{label}</span>
            <span className="ml-2 text-[var(--color-text-muted)]">
              {reasons.length === 0 ? "No commander's-attention items." : reasons.join(" · ")}
            </span>
          </span>
        }
      />
    </div>
  );
}

function Field({ label, body }: { label: string; body: React.ReactNode }) {
  return (
    <div>
      <div
        className="font-mono uppercase text-[var(--color-text-muted)]"
        style={{ fontSize: "10px", letterSpacing: "var(--tracking-widest)" }}
      >
        {label}
      </div>
      <div className="mt-1 font-mono text-xs text-[var(--color-text)] tracking-wide">
        {body}
      </div>
    </div>
  );
}

// Walkthrough #JOB-E (review #51 PULSE) — "How MC% is calculated" inline
// help. Operators repeatedly asked which definition each surface uses;
// this is the single canonical answer pinned next to the Overall MC chip.
//
// Strict MC = readiness_code == "MC". PMC is partial-mission-capable and
// is NOT counted as MC. Same number across PULSE Fleet Overview, BASTION
// COP cards, and the Overall MC chip — all read /api/bastion/cop's
// end-of-day snapshot.
function McMethodologyHelp({
  open,
  onToggle,
  onClose,
  datasetLastDay,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  datasetLastDay: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Click-outside + Escape close — operator-friendly dismissal that
  // doesn't trap focus or leave the popover stuck open during view nav.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  // Walkthrough audit: prior format was '26 APR 26' (year-suffix '26')
  // which an operator can mis-read as 'April 26th' if the day prefix
  // was clipped. Use full 'DD MMM YYYY' format so the day is
  // unambiguously prefixed and the year is the full four digits.
  const lastDayDisplay = (() => {
    if (!datasetLastDay) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(datasetLastDay);
    if (!m) return datasetLastDay;
    const [, y, mo, d] = m;
    const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    const monIdx = parseInt(mo, 10) - 1;
    if (monIdx < 0 || monIdx > 11) return datasetLastDay;
    return `${d} ${months[monIdx]} ${y}`;
  })();

  return (
    <div ref={wrapRef} className="relative ml-1">
      <Pressable
        onClick={onToggle}
        block={false}
        aria-expanded={open}
        aria-label="How is MC% calculated?"
        title="How is MC% calculated?"
        className="!min-h-0 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] font-mono text-[10px] font-semibold text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
      >
        ?
      </Pressable>
      {open && (
        <div
          role="dialog"
          aria-label="How MC% is calculated"
          className="absolute left-0 top-7 z-[40] w-80 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs shadow-2xl"
        >
          <div
            className="mb-1 font-mono uppercase text-[var(--color-text-muted)]"
            style={{ fontSize: "10px", letterSpacing: "var(--tracking-widest)" }}
          >
            How MC% is calculated
          </div>
          <div className="space-y-2 text-[var(--color-text)] tracking-wide">
            <div>
              <span className="font-semibold">Strict MC</span> = readiness_code == "MC".
              PMC (partial mission-capable) is <span className="font-semibold">not</span> counted as MC.
            </div>
            <div className="text-[var(--color-text-secondary)]">
              Source: end-of-day snapshot at <span className="font-mono">/api/bastion/cop</span>.
              Same number across PULSE Fleet Overview, BASTION COP cards, and this chip.
            </div>
            {lastDayDisplay && (
              <div className="text-[var(--color-text-muted)]">
                Last updated:{" "}
                <span className="font-mono tabular-nums text-[var(--color-text-secondary)]">
                  {lastDayDisplay}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

