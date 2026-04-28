# `demo-failsafe.{mp4,webm}` — live-demo failsafe recording

Wired by W2 Task #39. The files `demo-failsafe.mp4` (H.264, the canonical
take that ships to stage) and `demo-failsafe.webm` (VP9, fallback for
browsers without proprietary codecs — Playwright/CI Chromium, Firefox
on Linux without the H.264 add-on) next to this README are the recording
that the **Failsafe** affordance on `/demo` and `/pitch` plays when the
live demo dies on stage. They are also what the **Rehearsal** toggle plays
in a side-by-side PIP for drift checks.

## What ships in the repo today

A short black-frame **placeholder** with the text
"SPIRE · FAILSAFE PLACEHOLDER — Re-record /demo before stage". The
placeholder exists so the player UX (loading, controls, error, close)
is exercisable in dev and CI before the real recording lands.

If a presenter activates the failsafe with the placeholder still in
place, they will see the placeholder on screen — that is intentional and
loud, not silent.

## Recording the real take

1. Open `/demo` in a clean browser window (no devtools, no extensions
   that overlay the page). Maximize the window to ≥1920×1080.
2. Start a screen recorder (QuickTime / OBS) capturing only the SPIRE
   tab at 30fps.
3. Press **Play** in the demo cockpit at 1× speed. Let the scenario run
   end-to-end with the **Narration overlay** visible.
4. Stop the recording when the final beat dwell completes
   (~3:15 for the blood vignette).
5. Trim only if needed (silence at the head/tail).
6. Re-encode to BOTH `demo-failsafe.mp4` (H.264) and `demo-failsafe.webm`
   (VP9). Keep each file under 100 MB so the repo doesn't bloat.

A sane re-encode command (run both):

```
# H.264 / MP4 — canonical take for stage browsers (Chrome, Edge, Safari).
ffmpeg -i raw.mov -vf scale=1920:1080 -c:v libx264 -pix_fmt yuv420p \
  -movflags +faststart -profile:v high -preset slow -crf 23 \
  -an demo-failsafe.mp4

# VP9 / WebM — fallback for Playwright/CI Chromium and Firefox-on-Linux.
ffmpeg -i raw.mov -vf scale=1920:1080 -c:v libvpx-vp9 -pix_fmt yuv420p \
  -b:v 2M -row-mt 1 -an demo-failsafe.webm
```

(`-an` strips audio — the presenter narrates live regardless.)

## How the player consumes this file

The path is centralised in `frontend/src/state/failsafe.ts` as
`FAILSAFE_VIDEO_SRC`. The `FailsafePlayer` component renders
E1's `LoadingState` while `loadedmetadata` resolves, and falls back to
E1's `ErrorState` (with a Retry that re-mounts the `<video>`) if the
file is missing or undecodable.
