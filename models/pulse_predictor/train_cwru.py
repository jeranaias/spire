"""
PULSE predictor -- train a HawkStack 1D temporal CNN on the CWRU Bearing
Fault 12k drive-end dataset. Target: match or beat published SOTA (typically
98-99% on 10-class CWRU) with **8K parameters, no pretraining**.

This is the demo beat: same architecture family as the ECG Nano (which
handles MIT-BIH arrhythmia), now applied to industrial vibration signatures.
Once trained, we freeze the feature extractor and transfer-fine-tune on the
synthetic USMC fault time-series to show cross-domain generalization.

Run:
  python models/pulse_predictor/download_cwru.py
  python models/pulse_predictor/train_cwru.py --cycles 10 --epochs-per-cycle 10

Outputs:
  models/pulse_predictor/runs/pulse_cwru_v1/best.pt
  models/pulse_predictor/runs/pulse_cwru_v1/gain_curve.json
  models/pulse_predictor/runs/pulse_cwru_v1/cwru_confusion.json
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "models" / "pulse_predictor" / "data" / "cwru"
RUN_DIR = ROOT / "models" / "pulse_predictor" / "runs"

# Map CWRU filename -> (class_idx, class_name). 10-class setup is standard.
FILE_TO_CLASS = {
    # Normal
    "97.mat": 0, "98.mat": 0, "99.mat": 0, "100.mat": 0,
    # Inner race fault (3 sizes)
    "105.mat": 1, "106.mat": 1, "107.mat": 1, "108.mat": 1,
    "169.mat": 2, "170.mat": 2, "171.mat": 2, "172.mat": 2,
    "209.mat": 3, "210.mat": 3, "211.mat": 3, "212.mat": 3,
    # Ball fault (3 sizes)
    "118.mat": 4, "119.mat": 4, "120.mat": 4, "121.mat": 4,
    "185.mat": 5, "186.mat": 5, "187.mat": 5, "188.mat": 5,
    "222.mat": 6, "223.mat": 6, "224.mat": 6, "225.mat": 6,
    # Outer race fault (3 sizes)
    "130.mat": 7, "131.mat": 7, "132.mat": 7, "133.mat": 7,
    "197.mat": 8, "198.mat": 8, "199.mat": 8, "200.mat": 8,
    "234.mat": 9, "235.mat": 9, "236.mat": 9, "237.mat": 9,
}

CLASS_NAMES = [
    "Normal", "IR_0.007", "IR_0.014", "IR_0.021",
    "B_0.007", "B_0.014", "B_0.021",
    "OR_0.007", "OR_0.014", "OR_0.021",
]

WINDOW = 2048           # ~170ms at 12 kHz
STEP = 1024             # 50% overlap
INPUT_CHANNELS = 1      # drive-end only


# ---------------------------------------------------------------------------
# Loader (scipy.io.loadmat lazy -- keeps this file importable even when scipy
# is not installed yet so the test runner and linter pass regardless)
# ---------------------------------------------------------------------------

def load_signal_from_mat(path: Path) -> np.ndarray:
    from scipy.io import loadmat
    mat = loadmat(str(path))
    # CWRU stores signal under names like "X097_DE_time" for drive-end.
    for key in mat.keys():
        if key.startswith("X") and "DE_time" in key:
            return mat[key].squeeze().astype(np.float32)
    # Fallback -- take the longest numeric array
    candidates = [(k, v) for k, v in mat.items() if isinstance(v, np.ndarray) and v.ndim <= 2]
    candidates.sort(key=lambda kv: kv[1].size, reverse=True)
    return candidates[0][1].squeeze().astype(np.float32)


def window_signal(signal: np.ndarray) -> np.ndarray:
    windows = []
    for start in range(0, len(signal) - WINDOW + 1, STEP):
        w = signal[start:start + WINDOW]
        # Per-window z-score normalization -- robust to varying rpm amplitudes.
        w = (w - w.mean()) / (w.std() + 1e-6)
        windows.append(w)
    return np.stack(windows) if windows else np.empty((0, WINDOW), dtype=np.float32)


class CWRUDataset(Dataset):
    def __init__(self, samples: list[tuple[np.ndarray, int]]) -> None:
        self.samples = samples

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int):
        x, y = self.samples[idx]
        return torch.from_numpy(x).unsqueeze(0), torch.tensor(y, dtype=torch.long)


def build_splits(seed: int = 42) -> tuple[CWRUDataset, CWRUDataset, CWRUDataset]:
    """Load all .mat files, window-segment, split by SIGNAL (not window) so
    the train/val/test windows never share a source signal."""
    rng = random.Random(seed)
    signals: list[tuple[np.ndarray, int, str]] = []
    for name, cls in FILE_TO_CLASS.items():
        path = DATA / name
        if not path.exists():
            raise FileNotFoundError(f"Missing CWRU file: {path} -- run download_cwru.py first")
        sig = load_signal_from_mat(path)
        signals.append((sig, cls, name))

    # Group by class, then 60/20/20 split over signals
    by_cls: dict = {}
    for sig, cls, name in signals:
        by_cls.setdefault(cls, []).append((sig, name))
    train_sigs, val_sigs, test_sigs = [], [], []
    for cls, group in by_cls.items():
        rng.shuffle(group)
        n = len(group)
        n_train = max(2, int(n * 0.6))
        n_val = max(1, int(n * 0.2))
        for sig, name in group[:n_train]:
            train_sigs.append((sig, cls))
        for sig, name in group[n_train:n_train + n_val]:
            val_sigs.append((sig, cls))
        for sig, name in group[n_train + n_val:]:
            test_sigs.append((sig, cls))

    def flatten(group: list[tuple[np.ndarray, int]]) -> list[tuple[np.ndarray, int]]:
        out = []
        for sig, cls in group:
            for w in window_signal(sig):
                out.append((w.copy(), cls))
        rng.shuffle(out)
        return out

    return CWRUDataset(flatten(train_sigs)), CWRUDataset(flatten(val_sigs)), CWRUDataset(flatten(test_sigs))


# ---------------------------------------------------------------------------
# Model -- 1D adaptation of ForgeHawk WEM-Diamond.
#
# ForgeHawk hits 97.63% mAP on DeepPCB at 82K params with:
#   - Diamond channel topology [26,26,18,8], neck=24
#   - 3-branch WEM with RF 3, 5, 13 (kernel 3 / kernel 5 / kernel 5 dilated 3)
#   - ECA channel attention at every stage
#   - BiFPN-Lite neck + FCOSLiteHead
# That receptive-field distribution (tight, mid-scale focus) is exactly right
# for bearing-fault vibration signatures: defect-passage pulses are short,
# defect-frequency sidebands are mid-range, shaft harmonics are long.
#
# For 10-class classification we drop the BiFPN + FCOS head and use a global
# average pool + Linear classifier. Target ~6-8K params.
# ---------------------------------------------------------------------------

class ConvBNAct1d(nn.Module):
    def __init__(self, in_ch: int, out_ch: int, k: int = 3, stride: int = 1, dilation: int = 1):
        super().__init__()
        p = (k + (k - 1) * (dilation - 1) - 1) // 2
        self.conv = nn.Conv1d(in_ch, out_ch, k, stride, p, dilation=dilation, bias=False)
        self.bn = nn.BatchNorm1d(out_ch)
        self.act = nn.SiLU(inplace=True)

    def forward(self, x):
        return self.act(self.bn(self.conv(x)))


class ECA1d(nn.Module):
    """1D port of ForgeHawk's Efficient Channel Attention."""

    def __init__(self, ch: int, k: int = 3):
        super().__init__()
        self.gap = nn.AdaptiveAvgPool1d(1)
        self.conv = nn.Conv1d(1, 1, kernel_size=k, padding=k // 2, bias=False)

    def forward(self, x):
        y = self.gap(x).transpose(-1, -2)
        y = self.conv(y).transpose(-1, -2)
        return x * y.sigmoid()


class WEM1d(nn.Module):
    """3-branch WEM at RF 3 / 5 / 13 (last dilated). Matches ForgeHawk RF."""

    def __init__(self, ch: int, reduction: int = 4):
        super().__init__()
        mid = max(ch // reduction, 2)
        self.b1 = nn.Sequential(
            nn.Conv1d(ch, mid, 1, bias=False), nn.SiLU(True),
            nn.Conv1d(mid, ch, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm1d(ch), nn.SiLU(True),
        )
        self.b2 = nn.Sequential(
            nn.Conv1d(ch, mid, 1, bias=False), nn.SiLU(True),
            nn.Conv1d(mid, ch, kernel_size=5, padding=2, bias=False),
            nn.BatchNorm1d(ch), nn.SiLU(True),
        )
        self.b3 = nn.Sequential(
            nn.Conv1d(ch, mid, 1, bias=False), nn.SiLU(True),
            # dilation 3 x kernel 5 => receptive field 13
            nn.Conv1d(mid, ch, kernel_size=5, padding=6, dilation=3, bias=False),
            nn.BatchNorm1d(ch), nn.SiLU(True),
        )
        self.refine = nn.Sequential(
            nn.Conv1d(ch, ch, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm1d(ch), nn.SiLU(True),
        )

    def forward(self, x):
        return self.refine(self.b1(x) + self.b2(x) + self.b3(x))


class PulseWEMDiamond(nn.Module):
    """1D WEM-Diamond classifier. Channel topology mirrors ForgeHawk's
    [26,26,18,8] but scaled down for the 10-class CWRU target."""

    def __init__(self, n_classes: int = 10, channels: tuple[int, int, int, int] = (14, 14, 10, 6)):
        super().__init__()
        c1, c2, c3, c4 = channels
        # Aggressive stem compresses 2048 -> 256 with shared early features.
        self.stem = nn.Sequential(
            ConvBNAct1d(INPUT_CHANNELS, c1 // 2, k=9, stride=4),
            ConvBNAct1d(c1 // 2, c1, k=3, stride=2),
        )
        self.stage1 = nn.Sequential(WEM1d(c1), ECA1d(c1))
        self.down2 = ConvBNAct1d(c1, c2, k=3, stride=2)
        self.stage2 = nn.Sequential(WEM1d(c2), ECA1d(c2))
        self.down3 = ConvBNAct1d(c2, c3, k=3, stride=2)
        self.stage3 = nn.Sequential(
            ConvBNAct1d(c3, c3, k=3),
            ConvBNAct1d(c3, c3, k=3),
            ECA1d(c3),
        )
        self.down4 = ConvBNAct1d(c3, c4, k=3, stride=2)
        self.stage4 = nn.Sequential(ConvBNAct1d(c4, c4, k=3), ECA1d(c4))
        self.pool = nn.AdaptiveAvgPool1d(1)
        self.head = nn.Linear(c4, n_classes)

    def forward(self, x):
        h = self.stem(x)
        h = self.stage1(h)
        h = self.stage2(self.down2(h))
        h = self.stage3(self.down3(h))
        h = self.stage4(self.down4(h))
        return self.head(self.pool(h).squeeze(-1))


# Keep the old name as an alias for the CLI so external scripts don't break.
PulseWEMTemporal = PulseWEMDiamond


# ---------------------------------------------------------------------------
# Train
# ---------------------------------------------------------------------------

def train_one_cycle(model, train_loader, val_loader, *, epochs: int, lr: float, device: str) -> dict:
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs, eta_min=lr * 0.01)
    loss_fn = nn.CrossEntropyLoss()
    best = {"acc": 0.0, "epoch": -1, "state": None}
    for ep in range(epochs):
        model.train()
        for x, y in train_loader:
            x, y = x.to(device), y.to(device)
            loss = loss_fn(model(x), y)
            opt.zero_grad()
            loss.backward()
            opt.step()
        sched.step()
        val_acc = evaluate(model, val_loader, device)["accuracy"]
        if val_acc > best["acc"]:
            best = {"acc": val_acc, "epoch": ep, "state": {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}}
        print(f"    ep {ep+1}/{epochs}  val_acc={val_acc:.4f}  best={best['acc']:.4f}")
    return best


def evaluate(model, loader, device: str) -> dict:
    model.eval()
    correct = total = 0
    confusion = [[0] * 10 for _ in range(10)]
    with torch.no_grad():
        for x, y in loader:
            x, y = x.to(device), y.to(device)
            logits = model(x)
            pred = logits.argmax(dim=1)
            correct += (pred == y).sum().item()
            total += y.size(0)
            for t, p in zip(y.tolist(), pred.tolist()):
                confusion[t][p] += 1
    return {"accuracy": correct / max(total, 1), "confusion": confusion, "total": total}


def count_params(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters() if p.requires_grad)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-name", default="pulse_cwru_v1")
    parser.add_argument("--cycles", type=int, default=10)
    parser.add_argument("--epochs-per-cycle", type=int, default=10)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--channels", type=str, default="18,18,14,8",
                        help="Diamond topology channels (ForgeHawk-style). "
                             "18,18,14,8 hits the spec's ~8K param claim; "
                             "14,14,10,6 goes smaller (~5K); "
                             "26,26,18,8 mirrors ForgeHawk literal (~17K).")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args(argv)

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    random.seed(args.seed)

    out_dir = RUN_DIR / args.run_name
    out_dir.mkdir(parents=True, exist_ok=True)

    print("[PULSE] Loading CWRU splits ...")
    train_ds, val_ds, test_ds = build_splits(seed=args.seed)
    print(f"    train windows: {len(train_ds)}  val: {len(val_ds)}  test: {len(test_ds)}")

    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True, num_workers=0)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, num_workers=0)
    test_loader = DataLoader(test_ds, batch_size=args.batch_size, num_workers=0)

    channels = tuple(int(x) for x in args.channels.split(","))
    assert len(channels) == 4, "Diamond topology needs exactly 4 channel widths"
    model = PulseWEMDiamond(n_classes=10, channels=channels).to(args.device)
    n_params = count_params(model)
    print(f"    model params: {n_params:,}")
    if n_params > 15_000:
        print(f"    WARNING: model exceeds PULSE target of ~8K parameters")

    gain_curve = []
    best_overall = {"acc": 0.0, "cycle": -1, "state": None}
    for cycle in range(args.cycles):
        cycle_lr = args.lr * (1.0 if cycle == 0 else 0.7 ** cycle)
        print(f"\n[PULSE] Cycle {cycle+1}/{args.cycles}  (lr={cycle_lr:.2e})")
        result = train_one_cycle(
            model, train_loader, val_loader,
            epochs=args.epochs_per_cycle, lr=cycle_lr, device=args.device,
        )
        gain_curve.append({"cycle": cycle + 1, "best_val_acc": result["acc"], "best_epoch": result["epoch"]})
        model.load_state_dict(result["state"])
        if result["acc"] > best_overall["acc"]:
            best_overall = {"acc": result["acc"], "cycle": cycle + 1, "state": result["state"]}

    model.load_state_dict(best_overall["state"])
    final = evaluate(model, test_loader, args.device)

    torch.save({
        "state_dict": model.state_dict(),
        "config": vars(args),
        "n_params": n_params,
        "classes": CLASS_NAMES,
        "window": WINDOW,
        "step": STEP,
        "architecture": "PulseWEMDiamond (1D port of ForgeHawk WEM-Diamond)",
        "channels": channels,
        "wem_rf": [3, 5, 13],
    }, out_dir / "best.pt")

    (out_dir / "gain_curve.json").write_text(json.dumps(gain_curve, indent=2))
    (out_dir / "cwru_confusion.json").write_text(json.dumps({
        "classes": CLASS_NAMES,
        "matrix": final["confusion"],
    }, indent=2))
    (out_dir / "summary.json").write_text(json.dumps({
        "best_val_acc": best_overall["acc"],
        "best_cycle": best_overall["cycle"],
        "test_accuracy": final["accuracy"],
        "test_size": final["total"],
        "n_params": n_params,
    }, indent=2))

    print("\n[PULSE] Done on CWRU.")
    print(f"    best val acc:  {best_overall['acc']:.4f} (cycle {best_overall['cycle']})")
    print(f"    test accuracy: {final['accuracy']:.4f}")
    print(f"    parameters:    {n_params:,}")
    print(f"    artifacts:     {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
