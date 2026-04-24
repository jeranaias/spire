"""
SENTRY Tier-1 text classifier -- training script.

Architecture: WEM-inspired 1D text CNN with three parallel conv branches
(kernel sizes 3, 7, 15). Same receptive-field-diversity principle as the
HawkStack vision WEM modules, applied to token sequences. Roughly 100K
parameters -- target for the demo is 'handles 90% on CPU in <10ms/record'.

Training protocol: cyclic-restart SGDR, 10 cycles x 10 epochs each, fresh
AdamW optimizer per cycle. Same recipe used in the HawkStack topology paper
that recovered 14-55 pp hidden capacity across six domains.

Run:
  cd /path/to/spire
  python models/sentry_classifier/build_corpus.py         # one-time: build JSONL
  python models/sentry_classifier/train.py --epochs 100   # ~1-2 hours on RTX PRO 6000

Outputs:
  models/sentry_classifier/runs/sentry_v1/best.pt         # best-val checkpoint
  models/sentry_classifier/runs/sentry_v1/gain_curve.json # per-cycle best IoU
  models/sentry_classifier/runs/sentry_v1/confusion.json  # test confusion matrix
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
from collections import Counter
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "models" / "sentry_classifier" / "data" / "sentry_train.jsonl"
RUN_DIR = ROOT / "models" / "sentry_classifier" / "runs"

CLASSES = ["CLEAN", "SENSITIVE_PII", "SENSITIVE_GEO", "SENSITIVE_COMMS", "SENSITIVE_CLASSIFIED", "SENSITIVE_MULTI"]
FLAGS = ["pii", "geo", "comms", "classified", "controlled"]
MAX_LEN = 128
VOCAB_SIZE = 8000


# ---------------------------------------------------------------------------
# Tokenizer -- lightweight whitespace + punctuation split with a frozen vocab
# built from the training corpus. Keeps us free of external tokenizers so the
# model inference is transparent on a Toughbook CPU.
# ---------------------------------------------------------------------------

_WORD_RE = re.compile(r"\[[A-Z ]+\]|[A-Za-z]+|[0-9]+|[^\s]")


def tokenize(text: str) -> list[str]:
    return _WORD_RE.findall(text.lower())[:MAX_LEN]


class Tokenizer:
    def __init__(self, pad: str = "<pad>", unk: str = "<unk>") -> None:
        self.pad, self.unk = pad, unk
        self.stoi: dict[str, int] = {pad: 0, unk: 1}
        self.itos: list[str] = [pad, unk]

    def build(self, texts: list[str]) -> None:
        counts: Counter = Counter()
        for t in texts:
            counts.update(tokenize(t))
        for tok, _ in counts.most_common(VOCAB_SIZE - 2):
            self.stoi[tok] = len(self.itos)
            self.itos.append(tok)

    def encode(self, text: str) -> list[int]:
        ids = [self.stoi.get(t, 1) for t in tokenize(text)]
        if len(ids) < MAX_LEN:
            ids = ids + [0] * (MAX_LEN - len(ids))
        return ids[:MAX_LEN]

    def save(self, path: Path) -> None:
        path.write_text(json.dumps({"stoi": self.stoi, "itos": self.itos}))

    @classmethod
    def load(cls, path: Path) -> "Tokenizer":
        data = json.loads(path.read_text())
        tk = cls()
        tk.stoi, tk.itos = data["stoi"], data["itos"]
        return tk


# ---------------------------------------------------------------------------
# Model -- WEM-style 1D text CNN at ~100K params.
# ---------------------------------------------------------------------------

class WEMTextClassifier(nn.Module):
    def __init__(self, vocab: int = VOCAB_SIZE, embed_dim: int = 48, ch: int = 24):
        super().__init__()
        self.embed = nn.Embedding(vocab, embed_dim, padding_idx=0)
        # Three parallel receptive-field branches.
        self.branch3 = nn.Conv1d(embed_dim, ch, kernel_size=3, padding=1)
        self.branch7 = nn.Conv1d(embed_dim, ch, kernel_size=7, padding=3)
        self.branch15 = nn.Conv1d(embed_dim, ch, kernel_size=15, padding=7)
        self.pool = nn.AdaptiveMaxPool1d(1)
        self.cls_head = nn.Linear(ch * 3, len(CLASSES))
        self.flag_head = nn.Linear(ch * 3, len(FLAGS))

    def forward(self, x: torch.Tensor):
        h = self.embed(x).transpose(1, 2)  # (B, embed, T)
        b3 = F.gelu(self.branch3(h))
        b7 = F.gelu(self.branch7(h))
        b15 = F.gelu(self.branch15(h))
        feat = torch.cat([self.pool(b3), self.pool(b7), self.pool(b15)], dim=1).squeeze(-1)
        return self.cls_head(feat), self.flag_head(feat)


# ---------------------------------------------------------------------------
# Dataset + loaders
# ---------------------------------------------------------------------------

class SentryDataset(Dataset):
    def __init__(self, records: list[dict], tokenizer: Tokenizer) -> None:
        self.records = records
        self.tk = tokenizer

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, idx: int):
        r = self.records[idx]
        ids = torch.tensor(self.tk.encode(r["text"]), dtype=torch.long)
        cls = torch.tensor(CLASSES.index(r["class"]), dtype=torch.long)
        flag_vec = torch.zeros(len(FLAGS), dtype=torch.float32)
        for f in r.get("labels", []):
            if f in FLAGS:
                flag_vec[FLAGS.index(f)] = 1.0
        return ids, cls, flag_vec


def load_corpus(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f]


def split_dataset(records: list[dict], seed: int = 42) -> tuple[list[dict], list[dict], list[dict]]:
    """80/10/10 stratified by top-level class so every split has every label."""
    rng = random.Random(seed)
    by_cls: dict = {c: [] for c in CLASSES}
    for r in records:
        by_cls[r["class"]].append(r)
    train, val, test = [], [], []
    for _, rs in by_cls.items():
        rng.shuffle(rs)
        n = len(rs)
        n_train = int(n * 0.8)
        n_val = int(n * 0.1)
        train += rs[:n_train]
        val += rs[n_train:n_train + n_val]
        test += rs[n_train + n_val:]
    rng.shuffle(train); rng.shuffle(val); rng.shuffle(test)
    return train, val, test


# ---------------------------------------------------------------------------
# SGDR training loop -- fresh optimizer per cycle (the HawkStack "fresh" variant)
# ---------------------------------------------------------------------------

def train_one_cycle(model, train_loader, val_loader, *, epochs: int, lr: float, device: str) -> dict:
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs, eta_min=lr * 0.01)
    cls_loss = nn.CrossEntropyLoss()
    flag_loss = nn.BCEWithLogitsLoss()

    best_val = {"acc": 0.0, "epoch": -1, "state": None}
    for ep in range(epochs):
        model.train()
        for ids, cls, flags in train_loader:
            ids, cls, flags = ids.to(device), cls.to(device), flags.to(device)
            logits_cls, logits_flag = model(ids)
            loss = cls_loss(logits_cls, cls) + 0.5 * flag_loss(logits_flag, flags)
            opt.zero_grad()
            loss.backward()
            opt.step()
        sched.step()

        val_acc = evaluate(model, val_loader, device)["accuracy"]
        if val_acc > best_val["acc"]:
            best_val = {"acc": val_acc, "epoch": ep, "state": {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}}
        print(f"    ep {ep+1}/{epochs}  val_acc={val_acc:.4f}  best={best_val['acc']:.4f}")

    return best_val


def evaluate(model, loader, device: str) -> dict:
    model.eval()
    correct = 0
    total = 0
    flag_correct = 0
    flag_total = 0
    confusion = [[0] * len(CLASSES) for _ in CLASSES]
    with torch.no_grad():
        for ids, cls, flags in loader:
            ids, cls, flags = ids.to(device), cls.to(device), flags.to(device)
            logits_cls, logits_flag = model(ids)
            pred_cls = logits_cls.argmax(dim=1)
            correct += (pred_cls == cls).sum().item()
            total += cls.size(0)
            for t, p in zip(cls.tolist(), pred_cls.tolist()):
                confusion[t][p] += 1
            pred_flags = (logits_flag.sigmoid() > 0.5).float()
            flag_correct += (pred_flags == flags).sum().item()
            flag_total += flags.numel()
    return {
        "accuracy": correct / max(total, 1),
        "flag_accuracy": flag_correct / max(flag_total, 1),
        "confusion": confusion,
        "total": total,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def count_params(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters() if p.requires_grad)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-name", default="sentry_v1")
    parser.add_argument("--cycles", type=int, default=10)
    parser.add_argument("--epochs-per-cycle", type=int, default=10)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--embed-dim", type=int, default=48)
    parser.add_argument("--ch", type=int, default=24)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args(argv)

    torch.manual_seed(args.seed)
    random.seed(args.seed)

    out_dir = RUN_DIR / args.run_name
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[SENTRY] Loading corpus: {CORPUS}")
    records = load_corpus(CORPUS)
    train_r, val_r, test_r = split_dataset(records, seed=args.seed)
    print(f"    train={len(train_r)}  val={len(val_r)}  test={len(test_r)}")

    tokenizer = Tokenizer()
    tokenizer.build([r["text"] for r in train_r])
    tokenizer.save(out_dir / "tokenizer.json")
    print(f"    vocab size: {len(tokenizer.itos)}")

    train_ds = SentryDataset(train_r, tokenizer)
    val_ds = SentryDataset(val_r, tokenizer)
    test_ds = SentryDataset(test_r, tokenizer)
    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True, num_workers=0)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, num_workers=0)
    test_loader = DataLoader(test_ds, batch_size=args.batch_size, num_workers=0)

    model = WEMTextClassifier(vocab=len(tokenizer.itos), embed_dim=args.embed_dim, ch=args.ch).to(args.device)
    n_params = count_params(model)
    print(f"    model params: {n_params:,}")
    if n_params > 150_000:
        print(f"    WARNING: model exceeds SENTRY target of ~100K parameters")

    gain_curve = []
    best_overall = {"acc": 0.0, "cycle": -1, "state": None}

    for cycle in range(args.cycles):
        cycle_lr = args.lr * (1.0 if cycle == 0 else 0.7 ** cycle)
        print(f"\n[SENTRY] Cycle {cycle+1}/{args.cycles}  (lr={cycle_lr:.2e})")
        result = train_one_cycle(
            model, train_loader, val_loader,
            epochs=args.epochs_per_cycle, lr=cycle_lr, device=args.device,
        )
        gain_curve.append({"cycle": cycle + 1, "best_val_acc": result["acc"], "best_epoch": result["epoch"]})
        # Load best from this cycle before next cycle restarts the optimizer.
        model.load_state_dict(result["state"])
        if result["acc"] > best_overall["acc"]:
            best_overall = {"acc": result["acc"], "cycle": cycle + 1, "state": result["state"]}

    # Restore best overall and evaluate on test
    model.load_state_dict(best_overall["state"])
    final = evaluate(model, test_loader, args.device)

    torch.save({
        "state_dict": model.state_dict(),
        "config": vars(args),
        "vocab_size": len(tokenizer.itos),
        "embed_dim": args.embed_dim,
        "ch": args.ch,
        "n_params": n_params,
        "classes": CLASSES,
        "flags": FLAGS,
    }, out_dir / "best.pt")

    (out_dir / "gain_curve.json").write_text(json.dumps(gain_curve, indent=2))
    (out_dir / "confusion.json").write_text(json.dumps(final["confusion"], indent=2))
    (out_dir / "summary.json").write_text(json.dumps({
        "best_val_acc": best_overall["acc"],
        "best_cycle": best_overall["cycle"],
        "test_accuracy": final["accuracy"],
        "test_flag_accuracy": final["flag_accuracy"],
        "test_size": final["total"],
        "n_params": n_params,
    }, indent=2))

    print("\n[SENTRY] Done.")
    print(f"    best val acc:  {best_overall['acc']:.4f} (cycle {best_overall['cycle']})")
    print(f"    test accuracy: {final['accuracy']:.4f}")
    print(f"    test flag acc: {final['flag_accuracy']:.4f}")
    print(f"    parameters:    {n_params:,}")
    print(f"    artifacts:     {out_dir}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
