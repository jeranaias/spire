/**
 * FailsafePlayer — recorded-backup overlay for the live demo (Task #39).
 *
 * Mounted once at the App shell. Renders nothing while `mode === "off"`.
 *
 *   - `fullscreen`: a viewport-covering black surface with the recording
 *     centered, plus a minimal control bar (play/pause, seek, time,
 *     close). The presenter triggers this via a confirm dialog from the
 *     /demo or /pitch failsafe button (or the F9 hotkey, also gated by
 *     a confirm). Once open, Esc closes; mouse / hover keeps the control
 *     bar awake; idle hides the chrome so the recording reads cleanly.
 *
 *   - `rehearsal`: a small floating PIP pinned to the bottom-right so
 *     the live demo and the recording can be played in parallel for
 *     drift checks during prep. Has the same minimal controls in a
 *     compact form. Never intended for stage — purely a rehearsal aid.
 *
 * Playback safety
 *   - Uses E1's <LoadingState> while the video element fires
 *     `loadedmetadata`. If the file is missing / corrupt / can't be
 *     decoded, the video element raises an `error` event and we render
 *     E1's <ErrorState> with a Retry that re-mounts the <video> (forces
 *     a fresh fetch). The presenter still has the close affordance so a
 *     broken failsafe doesn't trap them.
 *   - Autoplay is muted by default — browser autoplay policy blocks
 *     unmuted autoplay on first interaction, but the presenter just
 *     pressed a button so we have a user gesture: we attempt unmuted,
 *     fall back to muted on rejection.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFailsafe, FAILSAFE_VIDEO_SOURCES, type FailsafeMode } from "../state/failsafe";
import { Button, IconButton, LoadingState, ErrorState } from "./ui";

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function FailsafePlayer() {
  const mode = useFailsafe((s) => s.mode);
  const close = useFailsafe((s) => s.close);

  // Esc closes from any mode. Listening at the window level so the
  // overlay catches Esc even when nothing inside it has focus.
  useEffect(() => {
    if (mode === "off") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, close]);

  if (mode === "off") return null;
  return <PlayerSurface mode={mode} onClose={close} />;
}

// ---------------------------------------------------------------------------
// PlayerSurface — owns the <video> element + controls. Re-mounted on
// retry by bumping `reloadKey`, which gives the <video> a fresh src and
// forces the browser to re-fetch.
// ---------------------------------------------------------------------------
interface PlayerSurfaceProps {
  mode: Exclude<FailsafeMode, "off">;
  onClose: () => void;
}
function PlayerSurface({ mode, onClose }: PlayerSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errDetail, setErrDetail] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Auto-hide control chrome in fullscreen after 2.5s of mouse idle so
  // the recording reads clean on stage.
  const [chromeVisible, setChromeVisible] = useState(true);
  const idleTimerRef = useRef<number | null>(null);

  const isFullscreen = mode === "fullscreen";

  // Wire the video element's lifecycle into local state. We don't trust
  // controls=true alone: some browsers' default control bars steal focus
  // from our chrome, and Esc / overlay close needs to know if the video
  // is currently advancing.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    function onLoadedMeta() {
      if (!v) return;
      setDuration(v.duration ?? 0);
      setPhase("ready");
      // Best-effort autoplay. Browsers may reject unmuted autoplay; if
      // so, retry muted (presenter narrates live anyway).
      v.play().catch(() => {
        v.muted = true;
        v.play().catch(() => {
          /* gave up — presenter will press Play */
        });
      });
    }
    function onTime() { setCurrentTime(v?.currentTime ?? 0); }
    function onPlayEvt() { setPlaying(true); }
    function onPause() { setPlaying(false); }
    function onErr() {
      setPhase("error");
      const code = v?.error?.code;
      const msg = v?.error?.message;
      setErrDetail(`MediaError code=${code ?? "?"}${msg ? ` · ${msg}` : ""}`);
    }
    function onEnded() { setPlaying(false); }

    v.addEventListener("loadedmetadata", onLoadedMeta);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlayEvt);
    v.addEventListener("pause", onPause);
    v.addEventListener("error", onErr);
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("loadedmetadata", onLoadedMeta);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlayEvt);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("error", onErr);
      v.removeEventListener("ended", onEnded);
    };
  }, [reloadKey]);

  // Auto-hide control chrome on mouse idle (fullscreen only; rehearsal
  // PIP keeps chrome up so the presenter can scrub at-a-glance).
  useEffect(() => {
    if (!isFullscreen) {
      setChromeVisible(true);
      return;
    }
    function bump() {
      setChromeVisible(true);
      if (idleTimerRef.current != null) {
        window.clearTimeout(idleTimerRef.current);
      }
      idleTimerRef.current = window.setTimeout(() => setChromeVisible(false), 2500);
    }
    bump();
    window.addEventListener("mousemove", bump);
    window.addEventListener("keydown", bump);
    return () => {
      window.removeEventListener("mousemove", bump);
      window.removeEventListener("keydown", bump);
      if (idleTimerRef.current != null) window.clearTimeout(idleTimerRef.current);
    };
  }, [isFullscreen]);

  // Lock body scroll while fullscreen so accidental wheel events don't
  // shift the underlying app behind the overlay.
  useEffect(() => {
    if (!isFullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isFullscreen]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const onScrub = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const t = Number(e.target.value);
    if (Number.isFinite(t)) v.currentTime = t;
  }, []);

  const onRetry = useCallback(() => {
    setPhase("loading");
    setErrDetail(null);
    setReloadKey((k) => k + 1);
  }, []);

  // Containers — fullscreen vs rehearsal PIP.
  const containerClass = isFullscreen
    ? "fixed inset-0 z-[200] flex items-center justify-center bg-black"
    : "fixed bottom-4 right-4 z-[150] flex w-[420px] max-w-[40vw] flex-col overflow-hidden rounded-md border border-[var(--color-border-active)] bg-black shadow-xl";

  return (
    <div
      className={containerClass}
      role="dialog"
      aria-modal={isFullscreen}
      aria-label={isFullscreen ? "Failsafe recording (fullscreen)" : "Failsafe recording (rehearsal)"}
      onMouseMove={() => setChromeVisible(true)}
    >
      {/* Video. Always mounted (so the loadedmetadata listener attaches
       * cleanly); the loading / error overlays sit on top until ready. */}
      <video
        key={reloadKey}
        ref={videoRef}
        preload="auto"
        playsInline
        // Hide native controls — we render our own so the chrome matches
        // SPIRE chassis and so the close affordance is always present.
        controls={false}
        className={
          isFullscreen
            ? "h-full w-full object-contain"
            : "block aspect-video w-full bg-black"
        }
      >
        {/* Multiple sources — browsers walk the list and pick the first
         * playable codec. MP4 (H.264) is canonical for stage; the WebM
         * (VP9) fallback covers Playwright Chromium / FF without
         * proprietary codecs. The presenter re-encodes both when they
         * refresh the recording (see public/demo-failsafe.README.md). */}
        {FAILSAFE_VIDEO_SOURCES.map((s) => (
          <source key={s.src} src={s.src} type={s.type} />
        ))}
      </video>

      {phase === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <LoadingState size="page" label="Loading failsafe recording…" />
        </div>
      )}

      {phase === "error" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/90 p-6">
          <ErrorState
            title="Failsafe unavailable"
            description="The recorded backup could not be loaded. Re-record and re-upload to frontend/public/demo-failsafe.mp4."
            detail={errDetail ?? undefined}
            onRetry={onRetry}
            secondaryAction={
              <Button variant="secondary" size="sm" onClick={onClose}>
                Close
              </Button>
            }
          />
        </div>
      )}

      {/* Controls chrome. In fullscreen, fades on idle; in rehearsal,
       * always visible (compact). */}
      <FailsafeChrome
        isFullscreen={isFullscreen}
        visible={chromeVisible}
        playing={playing}
        currentTime={currentTime}
        duration={duration}
        onTogglePlay={togglePlay}
        onScrub={onScrub}
        onClose={onClose}
        disabled={phase !== "ready"}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// FailsafeChrome — control bar (play/pause, scrub, time, close). Pulled
// out of PlayerSurface to keep that component readable. Re-renders cheap.
// ---------------------------------------------------------------------------
interface ChromeProps {
  isFullscreen: boolean;
  visible: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  onTogglePlay: () => void;
  onScrub: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClose: () => void;
  disabled: boolean;
}
function FailsafeChrome({
  isFullscreen, visible, playing, currentTime, duration,
  onTogglePlay, onScrub, onClose, disabled,
}: ChromeProps) {
  const wrapperClass = useMemo(() => {
    const base = "absolute left-0 right-0 flex items-center gap-3 bg-black/70 px-3 py-2 transition-opacity duration-300";
    const pos = isFullscreen ? "bottom-0" : "bottom-0";
    const op = visible ? "opacity-100" : "opacity-0 pointer-events-none";
    return `${base} ${pos} ${op}`;
  }, [isFullscreen, visible]);

  return (
    <>
      {/* Top strip — title + close. In fullscreen this floats; in
       * rehearsal it sits as a header above the video. */}
      <div
        className={
          (isFullscreen
            ? `absolute left-0 right-0 top-0 flex items-center justify-between bg-black/70 px-3 py-2 transition-opacity duration-300 ${visible ? "opacity-100" : "opacity-0 pointer-events-none"}`
            : "absolute left-0 right-0 top-0 flex items-center justify-between bg-black/70 px-3 py-1.5"
          )
        }
      >
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/70">
          {isFullscreen ? "FAILSAFE · recording" : "Failsafe · rehearsal"}
        </div>
        <IconButton
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close failsafe"
          title="Close (Esc)"
        >
          <span className="text-white">✕</span>
        </IconButton>
      </div>

      {/* Bottom strip — transport. */}
      <div className={wrapperClass}>
        <Button
          variant="secondary"
          size="sm"
          onClick={onTogglePlay}
          disabled={disabled}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : "▶"}
        </Button>
        <span className="font-mono text-[11px] tabular-nums text-white/80">
          {formatTime(currentTime)}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          onChange={onScrub}
          disabled={disabled}
          aria-label="Seek"
          className="flex-1 accent-[var(--color-primary)]"
        />
        <span className="font-mono text-[11px] tabular-nums text-white/80">
          {formatTime(duration)}
        </span>
      </div>
    </>
  );
}
