# SPIRE on NVIDIA Jetson Orin Nano

Run the full SPIRE contested-logistics OS — REST API, React UI, and an
on-device LLM — natively on a Jetson Orin Nano (8 GB). No cloud, no nginx,
no Docker. One `uvicorn` process serves the API **and** the built UI, and a
local Ollama model handles the AI co-pilot when there is no network.

- **Target board:** Jetson Orin Nano 8 GB (Ampere GPU)
- **OS / SDK:** JetPack 6 / Ubuntu 22.04, ARM64 (aarch64)
- **Serves at:** `http://<orin-ip>:8000/` (API + UI on one port)
- **On-device LLM:** Ollama + `gemma2:2b` (Q4, ~1.7 GB, GPU-accelerated)

---

## 1. Flash and verify JetPack 6

1. Flash JetPack 6 to the Orin Nano with NVIDIA **SDK Manager** (from an
   x86 Ubuntu host) or by writing the official SD-card image, per NVIDIA's
   Orin Nano getting-started guide. The Orin Nano **Super** dev kit ships
   ready to boot from SD.
2. Boot the board, finish the Ubuntu first-run setup, and confirm the
   platform is healthy:
   ```bash
   cat /etc/nv_tegra_release      # JetPack / L4T version banner
   uname -m                       # expect: aarch64
   nvidia-smi || sudo tegrastats  # GPU present; tegrastats is the Jetson tool
   ```
3. (Recommended) Put the board in its max-performance power mode so the
   model and dataset boot quickly:
   ```bash
   sudo nvpmodel -q               # show current mode
   sudo nvpmodel -m 0             # MAXN (highest); pick a lower mode if thermals demand
   sudo jetson_clocks             # pin clocks high
   ```

> **Python note:** JetPack 6 ships **Python 3.10**. SPIRE's `pyproject.toml`
> *declares* `requires-python >=3.12`, but the dependencies install and run
> fine on 3.10, so `setup.sh` installs them directly with `pip` into a venv
> instead of through the project metadata (which would hard-fail the pin).
> If you later put Python 3.12 on the board, nothing here breaks.

## 2. Clone the repo

```bash
sudo apt-get update -y
sudo apt-get install -y git
git clone <your-spire-remote> ~/spire
cd ~/spire
```

The setup script keys everything off the repo's own location, so `~/spire`,
`/opt/spire`, or anywhere else all work.

## 3. Run the setup

```bash
bash deploy/orin/setup.sh
```

The script is **idempotent** — re-run it any time; each step checks before
acting. It will:

1. Install **Ollama** (the installer auto-detects the Jetson GPU).
2. `systemctl enable --now ollama`.
3. `ollama pull gemma2:2b` (override with `SPIRE_MODEL=...`, see below).
4. Create `.venv` and `pip install` the backend + dataset dependencies.
5. `npm ci && npm run build` the frontend into `frontend/dist`
   (installs Node 20 via NodeSource if it is missing).
6. Write a repo-root `.env` **only if one does not already exist**
   (an existing `.env` is never overwritten).
7. Template + install `spire.service` and start it.

When it finishes it prints the LAN URL. To pick a different model up front:

```bash
SPIRE_MODEL=llama3.2:1b bash deploy/orin/setup.sh
```

## 4. Reach the UI on the LAN

Find the board's address and open it from any machine on the same network:

```bash
hostname -I        # first token is the Orin's LAN IP
```

Open **`http://<orin-ip>:8000/`** in a browser. The same port serves the API
(`/api/...`) and the bundled React UI — there is no separate web server.

Operate the service with systemd:

```bash
systemctl status spire        # health
journalctl -u spire -f        # live logs
sudo systemctl restart spire  # after pulling new code or rebuilding the UI
```

After a `git pull`, rebuild the UI and bounce the service (or just re-run
`setup.sh`, which is safe):

```bash
cd ~/spire/frontend && npm run build
sudo systemctl restart spire
```

---

## Model notes (8 GB budget)

The Orin Nano has **8 GB shared** between CPU and GPU, so the model has to
leave room for Ubuntu + the SPIRE backend (its deterministic dataset boots
in-memory at startup).

| Model | Size on disk | Fits 8 GB? | Use |
| --- | --- | --- | --- |
| **`gemma2:2b`** (Q4, default) | ~1.7 GB | **Yes** — comfortable | Gemma brand, GPU-accelerated, the recommended default |
| `gemma2:2b-instruct-q4_K_M` | ~1.7 GB | Yes | Same model, explicit quant tag if you want it pinned |
| `llama3.2:1b` | ~1.3 GB | Yes — fastest | Swap in when you want maximum tokens/sec |
| `gemma3:e2b` / any ~7 GB build | ~7+ GB | **No** | Will not fit alongside the OS + app on 8 GB — do not use |

SPIRE is wired for an **air-gapped** posture on the Orin: the `.env` sets
`SPIRE_LLM_PRIMARY_DISABLE=1`, so the LLM router skips the remote RigRun
proxy entirely and goes straight to the on-device Ollama model. When both
the model and the rules engine are unreachable the app still serves data —
the AI co-pilot simply degrades, it never blocks the OS.

Check what the GPU has loaded:

```bash
ollama ps         # resident models + VRAM/RAM use
ollama list       # everything pulled
```

---

## Demo talking points

> The entire contested-logistics OS — live common operating picture, the
> ingest service, and an AI co-pilot running a local **Gemma** model — runs
> on a Jetson Orin Nano: an 8 GB box you can hand a Marine, no cloud and no
> network required. The Orin Nano Super dev kit runs roughly **$249–$399**,
> and the compute **module** itself is tiny and only a fraction of a pound
> (the full dev kit, with its carrier board and heatsink, weighs more than
> the bare module). Plug it into any LAN and the whole team hits the same
> picture at `http://<orin-ip>:8000` — a cargo-pocket logistics OS that
> keeps thinking when the network does not.

*(Keep the pitch honest: the bare module is the tiny/light part; cite the
dev-kit price band and call the kit, with carrier + heatsink, heavier than
the module alone.)*

---

## Files in this directory

| File | Purpose |
| --- | --- |
| `setup.sh` | Idempotent installer (Ollama, model, venv, UI build, systemd) |
| `spire.service` | systemd unit template (uvicorn on `0.0.0.0:8000`, `After=ollama`) |
| `spire-orin.env.example` | `.env` template — copy to the **repo root** as `.env` |
| `README.md` | This guide |
