"""
Download the Case Western Reserve University Bearing Fault dataset (12k
drive-end) from the hackathon-provided mirror or the official CWRU source.

The hackathon pool surfaces this as a curated asset ("Case Western Reserve
University Bearing Fault dataset - 12k drive end"). If the hackathon mirror
is reachable, we pull from there; otherwise fall back to the public CSEGroups
engineering.case.edu mirror.

CWRU dataset structure on disk (what this script produces):

  data/cwru/
      normal/
          <rpm>/<sample>.mat
      inner_race_fault/
          007/<rpm>/<sample>.mat
          014/...
          021/...
      ball_fault/
          ...
      outer_race_fault/
          ...

Each .mat file holds the drive-end accelerometer signal at 12 kHz.
"""
from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "models" / "pulse_predictor" / "data" / "cwru"

# CWRU public mirrors (no auth). The hackathon mirror URL is set once the team
# pulls credentials from the portal and drops them into CWRU_HACKATHON_URL.
CWRU_PUBLIC_BASE = "https://engineering.case.edu/sites/default/files/"
CWRU_HACKATHON_URL = None  # populate once portal download link is confirmed

# 12k drive-end subset used in most published benchmarks -- 10-class setup.
# Filenames follow CWRU's index.
FILES_12K_DE = [
    # Normal baseline (1730, 1750, 1772, 1797 rpm)
    "97.mat", "98.mat", "99.mat", "100.mat",
    # Inner race fault 0.007"
    "105.mat", "106.mat", "107.mat", "108.mat",
    # Inner race fault 0.014"
    "169.mat", "170.mat", "171.mat", "172.mat",
    # Inner race fault 0.021"
    "209.mat", "210.mat", "211.mat", "212.mat",
    # Ball fault 0.007"
    "118.mat", "119.mat", "120.mat", "121.mat",
    # Ball fault 0.014"
    "185.mat", "186.mat", "187.mat", "188.mat",
    # Ball fault 0.021"
    "222.mat", "223.mat", "224.mat", "225.mat",
    # Outer race fault 0.007"
    "130.mat", "131.mat", "132.mat", "133.mat",
    # Outer race fault 0.014"
    "197.mat", "198.mat", "199.mat", "200.mat",
    # Outer race fault 0.021"
    "234.mat", "235.mat", "236.mat", "237.mat",
]


def download_file(url: str, dest: Path, chunk: int = 64 * 1024) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        print(f"    skip  {dest.name}  (already present)")
        return
    print(f"    get   {dest.name}  <-  {url}")
    with urllib.request.urlopen(url, timeout=60) as resp, dest.open("wb") as out:
        while True:
            buf = resp.read(chunk)
            if not buf:
                break
            out.write(buf)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", choices=["public", "hackathon"], default="public")
    args = parser.parse_args(argv)

    base = CWRU_HACKATHON_URL if args.source == "hackathon" else CWRU_PUBLIC_BASE
    if args.source == "hackathon" and base is None:
        print("Set CWRU_HACKATHON_URL in this script to use the hackathon mirror.")
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    print(f"Downloading CWRU 12k DE dataset from: {base}")
    for name in FILES_12K_DE:
        download_file(base + name, OUT / name)
    print(f"\nDone. Files saved to {OUT.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
