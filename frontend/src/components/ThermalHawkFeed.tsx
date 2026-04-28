/**
 * ThermalHawkFeed — live thermal video feed with bounding-box overlays
 * driven by the trained ThermalHawk (Thornveil) detector running inside SPIRE.
 *
 * Polls /bastion/thermalhawk/feed at ~5 FPS, draws each frame to an
 * `<img>` (server-rendered with bboxes already burned in), and shows a
 * status bar with model metadata + measured latency + frame index.
 *
 * Mounted in the BASTION ResponsePanel when a ThermalHawk sim is
 * active. Pauses automatically when the panel unmounts.
 */
import { useEffect, useRef, useState } from "react";
import { api, type ThermalHawkFeedFrame, type ThermalHawkFeedInfo } from "../api";
import { Pressable } from "./ui";

const TARGET_FPS = 5;
const TARGET_INTERVAL_MS = 1000 / TARGET_FPS;

export function ThermalHawkFeed() {
  const [info, setInfo] = useState<ThermalHawkFeedInfo | null>(null);
  const [frame, setFrame] = useState<ThermalHawkFeedFrame | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idxRef = useRef(0);
  const inFlightRef = useRef(false);
  const stoppedRef = useRef(false);

  // Fetch the static metadata once on mount.
  useEffect(() => {
    let cancelled = false;
    api.bastion.thermalhawkFeedInfo()
      .then((i) => {
        if (cancelled) return;
        setInfo(i);
        if (!i.model_loaded) {
          // Operator-facing copy. Finding F4: the prior message named
          // an internal env var (SPIRE_THERMALHAWK_WEIGHTS) — that's
          // a deploy-config detail, not something a Marine running a
          // CASEVAC can act on. Tell them what's happening on the
          // panel they're looking at, in their own language.
          setError(
            "Live thermal feed unavailable. Falling back to scripted incident profile."
          );
        }
      })
      .catch(() => {
        if (cancelled) return;
        setError(
          "Live thermal feed unavailable. Falling back to scripted incident profile."
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Polling loop. Re-fires as soon as the previous frame lands so we run
  // at full inference throughput; clamps to TARGET_INTERVAL_MS to cap at
  // the demo's target frame rate.
  useEffect(() => {
    if (!info?.model_loaded) return;
    stoppedRef.current = false;

    const loop = async () => {
      if (stoppedRef.current) return;
      if (paused) {
        // Re-check after a beat.
        setTimeout(loop, 200);
        return;
      }
      if (inFlightRef.current) {
        setTimeout(loop, 50);
        return;
      }
      inFlightRef.current = true;
      const t0 = performance.now();
      try {
        const f = await api.bastion.thermalhawkFeedFrame(idxRef.current);
        setFrame(f);
        idxRef.current = (idxRef.current + 1) % Math.max(1, f.frame_count_in_loop);
      } catch {
        // Operator-facing copy: never leak raw exception text into the
        // response panel. Mirror the init-path fallback so the operator
        // sees the same language whether the feed never started or
        // dropped mid-incident (finding F4).
        setError(
          "Live thermal feed unavailable. Falling back to scripted incident profile."
        );
      } finally {
        inFlightRef.current = false;
        const elapsed = performance.now() - t0;
        const wait = Math.max(0, TARGET_INTERVAL_MS - elapsed);
        setTimeout(loop, wait);
      }
    };
    loop();

    return () => {
      stoppedRef.current = true;
    };
  }, [info?.model_loaded, paused]);

  if (error) {
    return (
      <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
        <div className="mb-1 font-semibold uppercase text-[var(--color-warning)] tracking-widest">
          Live Feed Unavailable
        </div>
        <div>{error}</div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
        <span className="inline-block h-1.5 w-1.5 mr-1.5 rounded-full bg-[var(--color-primary)] animate-pulse" />
        Initializing live thermal feed…
      </div>
    );
  }

  const params = info.model_metadata.parameters;
  const valMap = info.model_metadata.validation_map_50_95;

  return (
    <div className="rounded-sm border border-[var(--color-danger-muted)] bg-[var(--color-bg)] overflow-hidden">
      {/* Header */}
      <div className="flex items-baseline justify-between border-b border-[var(--color-border)] px-2 py-1.5 font-mono text-xs tracking-wider">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-danger)]"
            style={{ boxShadow: "0 0 5px var(--color-danger)", animation: paused ? "none" : "pulse 1.4s ease-in-out infinite" }}
          />
          <span className="font-semibold uppercase text-[var(--color-danger)] tracking-widest">
            ◆ ThermalHawk · LIVE
          </span>
          {paused && (
            <span className="rounded-sm border border-[var(--color-warning)] px-1 text-[10px] uppercase text-[var(--color-warning)] tracking-widest">
              PAUSED
            </span>
          )}
        </div>
        <Pressable
          onClick={() => setPaused((p) => !p)}
          block={false}
          aria-label={paused ? "Resume thermal feed" : "Pause thermal feed"}
          className="!min-h-0 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-[1px] text-[10px] uppercase text-[var(--color-text-muted)] hover:text-[var(--color-text)] tracking-widest"
        >
          {paused ? "▶ Play" : "⏸ Pause"}
        </Pressable>
      </div>

      {/* Frame */}
      <div className="relative bg-black">
        {frame ? (
          <img
            // The PNG already has bboxes burned in by the backend; no
            // canvas overlay needed. data: URI keeps the render synchronous
            // with the JSON payload (no second network round-trip).
            src={`data:image/png;base64,${frame.frame_png_b64}`}
            alt={`ThermalHawk frame ${frame.frame_idx}`}
            className="block w-full select-none"
            draggable={false}
          />
        ) : (
          <div className="flex h-48 items-center justify-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            Streaming first frame…
          </div>
        )}

        {/* HUD overlay — bbox count + latency, top-right */}
        {frame && (
          <div
            className="absolute right-1.5 top-1.5 flex flex-col items-end gap-0.5 font-mono text-[10px] uppercase tracking-widest"
          >
            <span
              className="rounded-sm border border-[var(--color-danger)] bg-[color-mix(in_oklab,#000_70%,transparent)] px-1.5 py-[1px]"
              style={{ color: frame.boxes.length > 0 ? "var(--color-danger)" : "var(--color-text-muted)" }}
            >
              {frame.boxes.length} TGT
            </span>
            <span className="rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,#000_70%,transparent)] px-1.5 py-[1px] text-[var(--color-text)]">
              {frame.latency_ms.toFixed(0)} MS
            </span>
            <span className="rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,#000_70%,transparent)] px-1.5 py-[1px] text-[var(--color-text-muted)]">
              F {frame.frame_idx + 1}/{frame.frame_count_in_loop}
            </span>
          </div>
        )}
      </div>

      {/* Footer — model card + per-frame top-confidence */}
      <div className="border-t border-[var(--color-border)] px-2 py-1.5 font-mono text-[10px] tracking-wide">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[var(--color-text-muted)] uppercase tracking-widest">
            ThermalHawk (Thornveil)
            {params != null && <span> · {(params / 1e6).toFixed(2)}M params</span>}
            {valMap != null && <span> · val mAP {(valMap * 100).toFixed(1)}%</span>}
          </span>
          {frame && frame.boxes.length > 0 && (
            <span className="tabular-nums text-[var(--color-danger)]">
              top {(Math.max(...frame.boxes.map((b) => b.score)) * 100).toFixed(1)}%
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[var(--color-text-muted)] tracking-wide" title={info.source}>
          src: {info.source} · score≥{(info.default_score_threshold * 100).toFixed(0)}%
        </div>
      </div>
    </div>
  );
}
