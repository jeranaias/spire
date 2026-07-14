# SPIRE — Backup Demo Video Script

**Purpose:** stage-failure fallback. If the laptop dies, the venue WiFi
collapses, the live URL goes red, or any other "the demo just stopped
working" event: pull up a phone, hit play. The video has to land the
same 5-of-9 use cases pitch in 60–90 seconds with zero interaction.

**Length target:** 60–90 seconds. Anything longer loses the room. The
live demo is 7 minutes; the backup video is the spine of the live demo
compressed to under two minutes.

**Recording setup:** OBS / QuickTime / Loom · 1920×1080 · 30 fps · MP4
H.264. No mic — ship a captioned version (built-in subtitles on iOS
Photos works for shoulder-of-laptop playback). Save the master at:
`~/spire/demo/backup-1080p.mp4`. Save a 720p phone-friendly cut at
`~/spire/demo/backup-720p.mp4`. Carry both on the demo phone.

---

## Pre-record checklist

- [ ] `https://spire-mdm.fly.dev` warm in cache (load it once before recording)
- [ ] Operator role set to **MEF Commander**
- [ ] Browser zoom **100%**, dev tools closed
- [ ] No notifications on the recording machine (Do Not Disturb)
- [ ] Cursor visible in OBS settings — judges should see what's clicked
- [ ] Audio: silent record OR captioned voiceover. Silent is safer for stage.

---

## The 90-second cut (timed beats)

### 0:00–0:08 · Cold open with the explosion

- Land on `/bastion` as MEF Commander.
- 0:01: click **Simulate ThermalHawk** (red button bottom-left).
- Cordon rings drop, FPCON pill flips BRAVO → CHARLIE, target reticle spins.
- Within 3s: a Fused Threats card appears at top-left of alert sidebar.

**On-screen caption:**
> "UAS over a Marine motor pool. Cross-sensor fusion. FPCON elevated.
> Local-first. No cloud. **This is SPIRE.**"

### 0:08–0:14 · The 5-of-9 frame

- Pause briefly on the BASTION map with cordons live.

**Caption:**
> "Most teams here picked one of nine MDM problems. SPIRE solves five."

- Flash of `docs/USE_CASE_MAPPING.md` table (a screenshot, 4 sec) listing
  #2, #5, #6, #7, #9 against their SPIRE surfaces.

### 0:14–0:25 · GC-1 + GC-3 in PULSE

- TopBar role dropdown → **G-4 (2d MLG)**.
- Click **PULSE** tab → **Forecast**.
- Monte Carlo chart renders. Cursor hovers the p10/p90 envelope.

**Caption:**
> "200-path Monte Carlo. P-cross-threshold 85%. Recommend Actions ranked
> by impact-per-dollar-per-day."

- Scroll to Recommend Actions. Click **Approve** on top action.
- Toast: *"Cannibalization proposal logged · audit chain entry created."*

### 0:25–0:34 · GC-5 Coalition

- TopBar → **Data Custodian**. Auto-routes to SENTRY.
- Click **Coalition** tab.
- Click **JAPAN · JSDF**.
- Preview re-scopes within 1s: 130/200 SRs releasable, 5 redaction fields.
- Click **AUSTRALIA · ADF** — preview updates again to 149/200 + 2 fields.

**Caption:**
> "Live policy engine. Switch partner, watch redactions and unit visibility
> repaint. JGSDF MOU. ADF ANZUS."

### 0:34–0:44 · GC-7 Air-gap + GC-2 sync

- TopBar → **Security Manager**.
- Click **AIR-GAP** toggle. StatusFooter goes red, Q:0 chip appears.

**Caption:**
> "Adversary kills SATCOM. SPIRE keeps operating. Writes queue locally."

- Click again to release. Toast: *"Air-gap released · 0 queued ops replayed."*
- Click TopBar **Node Status** chip.
- Click **Seed Demo Conflict**.
- Vector-clock cards appear with two competing payloads + Pick buttons.

**Caption:**
> "CRDT vector-clock reconciliation. Operator picks the winner. Loser
> preserved in audit chain. Nobody else has this."

### 0:44–0:55 · SPIRO closes the loop

- Switch back to **MEF Commander**.
- Press `Ctrl+/` → SPIRO panel slides in from right.
- Type: *"what's the worst thing in my fleet right now?"*
- SPIRO returns a 2-step plan: status_summary → predict_failures.
- Click **Approve & Run**.
- Result: top 3 deadlined units, asset IDs cited.

**Caption:**
> "SPIRO — the Officer aspect of SPIRE. Marines ask in plain English.
> Gemma 4 plans. Operator approves. Audit-chained."

### 0:55–1:05 · The close

- Brief pan across the audit footer (SHA-256 fingerprint visible).
- StatusFooter ticker: `NETWORK 0 egress · ENCRYPTION AES-256-GCM ·
  AUDIT-SHA256 …`

**Caption (final):**
> "Lattice watches the fight. Gotham watches the adversary. **Nobody is
> watching the supply chain. We are.**
>
> Five of nine, in one operating system, on a laptop. No cloud.
> Built by Marines, on duty time.
>
> spire-mdm.fly.dev · MDM 2026"

### 1:05–1:30 · Slow audit-chain pan (optional padding)

If you over-shoot 60s, add a slow zoom on the audit chain page in ADMIN:
SHA-256 hash + every entry showing actor + timestamp + decision kind.
Reads as proof of the substrate. Caption: *"Every action you just saw —
proven in a hash-chain."*

---

## Failure-mode fallback plays

What to do on stage if the live demo fails. The video is the bottom of
the playbook; check earlier escapes first.

### If the laptop is still alive but a view is broken

1. **Stale-chunk crash** ("Failed to fetch dynamically imported module"):
   - The error UI now says "Build out of date — refresh to load it."
   - Click Reload. ~2s and you're back.
2. **Backend 502 on `/api/system/status`**:
   - Wait 5s. Fly machine is auto-stopped, waking up. The retry helper
     surfaces "Waking up — one moment" automatically.
3. **A specific view crashes**:
   - Chrome stays alive (the boundary now scopes per-view). Switch tab
     or role and continue from a different surface.

### If the laptop dies entirely

1. Pull out the demo phone.
2. Hit play on the 90s backup video.
3. While playing, narrate over: *"What you're seeing happened on the
   live URL ten minutes before stage. The system runs locally — what
   you're watching is exactly what's running. Let me show you the
   audit chain proves it…"*
4. After the video, hand judges the printed `USE_CASE_MAPPING.md` page.
5. Take the Q&A live — the Q&A is the meat of the score anyway.

### If venue WiFi is gone but the laptop works

1. Hit AIR-GAP toggle in SPIRE. Demo continues fully offline.
2. *This is actually the strongest pitch moment* — "the demo
   environment just lost network and SPIRE is still running. That's
   the point of GC-7."
3. Skip the LLM-backed beats (NL TMR, SPIRO general queries). The
   structured paths (forecast, cannib, coalition preview) all work
   offline.

### If the live URL is red mid-pitch

1. Don't try to fix it on stage. Switch to phone, play video.
2. After judging, the operational telemetry will tell us what happened.
3. The judges remember the recovery, not the failure.

---

## Recording the actual video — what to capture

```bash
# Record full 1920x1080 at 30fps with cursor visible.
# (OBS or ffmpeg one-liner; below is ffmpeg for headless)
ffmpeg -f gdigrab -framerate 30 -i desktop -c:v libx264 -preset slow \
       -crf 18 -pix_fmt yuv420p ~/spire/demo/backup-master.mov

# Then trim + caption-burn:
ffmpeg -i backup-master.mov -ss 00:00:00 -t 00:01:30 \
       -vf "subtitles=backup-captions.srt:force_style='FontName=IBM Plex Mono,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=3,BorderStyle=3'" \
       -c:v libx264 -preset slow -crf 18 \
       backup-1080p-captioned.mp4

# Phone-friendly cut:
ffmpeg -i backup-1080p-captioned.mp4 -vf scale=1280:720 -b:v 2M \
       backup-720p.mp4
```

Caption file (`backup-captions.srt`) — copy from the timed beats above,
one block per beat.

---

## Pre-stage final checklist

- [ ] `backup-1080p-captioned.mp4` and `backup-720p.mp4` on the phone
- [ ] Phone charged ≥ 80%, on silent
- [ ] Bluetooth disconnected (no airpod auto-routing during playback)
- [ ] `USE_CASE_MAPPING.md` printed on a single page in your back pocket
- [ ] Live URL `https://spire-mdm.fly.dev` open in a phone browser tab
      as a third fallback (judges may want to click through after)
- [ ] Practice the failure-mode plays once before walking on stage
