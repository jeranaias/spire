"""One-shot: project every MGRS grid in installation_data.json to lat/lon
via flat-earth offset from the installation center, write back in place.

Always overwrites — re-run after changing the center coordinates to
re-bake the entire fixture cleanly."""
import json
import math
from pathlib import Path

PATH = Path("D:/projects/spire/dataset/data/installation_data.json")


def parse_grid(g: str) -> tuple[int, int]:
    s = g.replace(" ", "")
    digits = s[-10:]
    return int(digits[:5]), int(digits[5:])


def project(grid: str, c_grid: str, c_lat: float, c_lon: float):
    e1, n1 = parse_grid(grid)
    e2, n2 = parse_grid(c_grid)
    dE = e1 - e2
    dN = n1 - n2
    m_per_deg_lat = 111320.0
    m_per_deg_lon = 111320.0 * math.cos(math.radians(c_lat))
    return c_lat + dN / m_per_deg_lat, c_lon + dE / m_per_deg_lon


def main():
    inst = json.loads(PATH.read_text(encoding="utf-8"))
    base = inst["installation"]
    cg = base["center_grid"]
    cl = float(base["center_lat"])
    co = float(base["center_lon"])
    n = 0
    for arr in ("buildings", "ecps", "rally_points"):
        for item in inst.get(arr, []):
            if "grid" in item:
                lat, lon = project(item["grid"], cg, cl, co)
                item["lat"] = round(lat, 6)
                item["lon"] = round(lon, 6)
                n += 1
    PATH.write_text(json.dumps(inst, indent=2), encoding="utf-8")
    print(f"baked lat/lon for {n} entries · center=({cl}, {co})")


if __name__ == "__main__":
    main()
