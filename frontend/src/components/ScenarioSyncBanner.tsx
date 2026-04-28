/**
 * ScenarioSyncBanner — sticky cockpit-wide banner that warns when the
 * scripted player has fallen out of sync with the backend mission clock.
 *
 * Why this exists: the player walks the FE through beats by issuing
 * `scenario.control seek` against the backend. When that seek fails
 * silently (DDIL DISCONNECTED dropping the write, a 5xx, an auth deny,
 * a transient network blip), the cockpit used to keep ticking PLAYING
 * through its narration while the backend timeline stayed pinned at the
 * last successful offset. The presenter would describe events that the
 * underlying views never received.
 *
 * Now: ScenarioPlayerHost stamps `syncError` on any non-success seek
 * and `lastSyncedOffsetMin` on any success. This banner reads both and
 * renders a high-z-index sticky strip at the top of the viewport for as
 * long as the desync persists, naming the gap so the operator can
 * decide whether to keep going, retry, or reset.
 *
 * Mounted at the App shell — survives route changes, sits above all
 * normal content but below the failsafe / hard-error overlays.
 */
import { useState } from "react";
import { api } from "../api";
import { formatApiError } from "../api-retry";
import { useScenarioPlayer } from "../state/scenarioPlayer";
import { useSpireStore } from "../state/store";
import { Pressable } from "./ui";

function formatOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = Math.round(abs % 60);
  return `H${sign}${String(h).padStart(3, "0")}:${String(m).padStart(2, "0")}`;
}

export function ScenarioSyncBanner() {
  const syncError = useScenarioPlayer((s) => s.syncError);
  const lastSyncedOffsetMin = useScenarioPlayer((s) => s.lastSyncedOffsetMin);
  const status = useScenarioPlayer((s) => s.status);
  const noteSyncSuccess = useScenarioPlayer((s) => s.noteSyncSuccess);
  const setSyncError = useScenarioPlayer((s) => s.setSyncError);
  const ddilMode = useSpireStore((s) => s.ddilMode);
  const [retrying, setRetrying] = useState(false);

  // Visibility is gated solely on `syncError`. That flag is set by
  // ScenarioPlayerHost only when the host has actually attempted a
  // dispatch (i.e. an operator was driving the cockpit), and it is
  // cleared on loadScenario / reset / successful seek round-trip — so
  // an idle / ready cockpit has nothing to display here.
  if (!syncError) return null;
  if (status === "idle") return null;

  const player = formatOffset(syncError.attemptedOffsetMin);
  const backend =
    lastSyncedOffsetMin === null
      ? "never confirmed"
      : formatOffset(lastSyncedOffsetMin);

  // Surface the most likely cause inline. DDIL DISCONNECTED is the
  // dominant failure mode for the demo; auth denies are the second.
  // Anything else falls through to the raw error message.
  const ddilHint =
    ddilMode === "DISCONNECTED"
      ? "Comms denied — backend write was queued locally, not applied."
      : ddilMode === "INTERMITTENT"
      ? "Comms intermittent — backend may have dropped the write on the wire."
      : null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="pointer-events-none fixed inset-x-0 top-0 z-[7900] flex justify-center px-4 pt-2"
    >
      <div
        className="pointer-events-auto flex w-full max-w-[1280px] items-start gap-3 rounded-sm border border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning)_18%,var(--color-surface))] px-3 py-2 shadow-lg"
      >
        <span aria-hidden className="mt-0.5 font-mono text-[14px] text-[var(--color-warning)]">
          ▲
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-widest text-[var(--color-warning)]">
            Backend out of sync — cockpit advanced past the mission clock
          </div>
          <div className="mt-1 font-mono text-[11px] tabular-nums text-[var(--color-text)]">
            <span className="text-[var(--color-text-secondary)]">Player at</span>{" "}
            <span className="font-semibold">{player}</span>
            <span className="mx-2 text-[var(--color-text-muted)]">·</span>
            <span className="text-[var(--color-text-secondary)]">Backend at</span>{" "}
            <span className="font-semibold">{backend}</span>
          </div>
          {ddilHint && (
            <div className="mt-0.5 font-sans text-[11px] text-[var(--color-text-secondary)]">
              {ddilHint}
            </div>
          )}
          <div className="mt-0.5 break-words font-mono text-[10px] tracking-wide text-[var(--color-text-muted)]">
            {syncError.message}
          </div>
        </div>
        <Pressable
          onClick={async () => {
            if (retrying) return;
            // Imperative retry — calls the same seek + pause sequence the
            // ScenarioPlayerHost dispatch effect runs, but doesn't depend
            // on a state-change to re-fire (a `jumpTo(currentIdx)` won't
            // re-run the host effect because the dispatch dedupe key is
            // (beatIndex, status) and neither changes here).
            setRetrying(true);
            const s = useScenarioPlayer.getState();
            const beat = s.beats[s.currentBeatIndex];
            const targetOffset = beat?.offset_min ?? 0;
            try {
              await api.system.scenarioControl("seek", { offset_min: targetOffset });
              await api.system.scenarioControl("pause");
              noteSyncSuccess(targetOffset);
            } catch (e) {
              setSyncError({
                message: formatApiError(e),
                attemptedOffsetMin: targetOffset,
              });
            } finally {
              setRetrying(false);
            }
          }}
          disabled={retrying}
          block={false}
          aria-label="Retry mission-clock sync"
          className="!min-h-0 flex h-7 shrink-0 items-center rounded-sm border border-[var(--color-warning)] bg-[var(--color-bg)] px-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-warning)] hover:bg-[color-mix(in_oklab,var(--color-warning)_15%,var(--color-bg))] disabled:opacity-50"
        >
          {retrying ? "Retrying…" : "Retry sync"}
        </Pressable>
      </div>
    </div>
  );
}
