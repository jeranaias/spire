"""
Drift guard for the deck-customer ↔ sign-in-identity alignment (task #57).

Asserts that the four MOCK_USERS' (unit, parent_command) pairs lie on the
documented USMC chain that pitch slide 2 and the UnitIcon visual name as
the pilot customer. Failing this test means slide 2 and the topbar have
drifted; update both ends before re-greening.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from backend.auth import MOCK_USERS


PILOT_CUSTOMER_CHAIN: set[tuple[str, str]] = {
    ("CLB-Det",   "3d MLR"),
    ("3d MLR",    "3d MarDiv"),
    ("3d MarDiv", "MARFORPAC"),
    ("III MEF",   "MARFORPAC"),
}

REPO_ROOT = Path(__file__).resolve().parents[2]
SLIDES_TS = REPO_ROOT / "frontend" / "src" / "views" / "pitch" / "slides.ts"
PITCH_VISUAL_TSX = REPO_ROOT / "frontend" / "src" / "views" / "pitch" / "PitchVisual.tsx"


def test_mock_users_sit_on_pilot_customer_chain():
    drift: list[str] = []
    for u in MOCK_USERS:
        edge = (u["unit"], u["parent_command"])
        if edge not in PILOT_CUSTOMER_CHAIN:
            drift.append(f"{u['rank']} {u['last_name']} ({u['role']}) -> {edge!r}")
    assert not drift, (
        "MOCK_USERS off the pilot-customer chain "
        f"{sorted(PILOT_CUSTOMER_CHAIN)}: " + "; ".join(drift)
    )


def _slide_entry(text: str, slide_id: str) -> str:
    """Return the slice of slides.ts containing the SLIDES entry with the
    given `id:` literal, up to the next entry's `id:` or end of file."""
    m = re.search(rf'id:\s*"{re.escape(slide_id)}"', text)
    if not m:
        return ""
    start = text.rfind("{", 0, m.start())
    if start == -1:
        return ""
    nxt = re.search(r'id:\s*"', text[m.end():])
    end = m.end() + nxt.start() if nxt else len(text)
    return text[start:end]


def test_slides_customer_entry_names_pilot_customer():
    """Slide 2 (id: "customer") must explicitly name 3d MLR + CLB and Kaneohe."""
    if not SLIDES_TS.exists():
        pytest.skip(f"slides.ts not present at {SLIDES_TS}")
    text = SLIDES_TS.read_text(encoding="utf-8")
    entry = _slide_entry(text, "customer")
    assert entry, "Could not locate the 'customer' slide entry in slides.ts"
    missing = [t for t in ("3d MLR", "CLB-Det", "Kaneohe") if t not in entry]
    assert not missing, (
        f"slides.ts customer slide no longer mentions {missing!r}; "
        f"slide 2 has drifted from the MOCK_USERS persona."
    )


def _function_body(text: str, name: str) -> str:
    """Return the body of a top-level `function {name}() {{ ... }}` block."""
    m = re.search(rf"function\s+{re.escape(name)}\s*\([^)]*\)\s*\{{", text)
    if not m:
        return ""
    depth = 1
    i = m.end()
    while i < len(text) and depth:
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        i += 1
    return text[m.end():i - 1]


def test_no_drift_to_old_persona_on_customer_slides():
    """Slides 1/2/4/7/8 (the customer-bearing slides per the task brief) must
    not reference the prior CLB-6 / 2d MLG / II MEF / MARFORCOM persona."""
    if not SLIDES_TS.exists():
        pytest.skip(f"slides.ts not present at {SLIDES_TS}")
    text = SLIDES_TS.read_text(encoding="utf-8")
    forbidden = ("CLB-6", "2d MLG", "II MEF", "MARFORCOM")
    drift: list[str] = []
    for sid in ("hook", "customer", "live-demo", "transition", "ask"):
        entry = _slide_entry(text, sid)
        if not entry:
            continue
        hits = [t for t in forbidden if t in entry]
        if hits:
            drift.append(f"slide '{sid}' mentions {hits!r}")
    assert not drift, (
        "Old-persona references reintroduced on customer-bearing slides; "
        "these must agree with MOCK_USERS: " + "; ".join(drift)
    )


def test_pitch_visual_unit_icon_matches_persona():
    """PitchVisual UnitIcon SVG must show the matching unit + MARFORPAC label."""
    if not PITCH_VISUAL_TSX.exists():
        pytest.skip(f"PitchVisual.tsx not present at {PITCH_VISUAL_TSX}")
    text = PITCH_VISUAL_TSX.read_text(encoding="utf-8")
    body = _function_body(text, "UnitIcon")
    assert body, "Could not locate the UnitIcon function in PitchVisual.tsx"
    # SVG kerning inserts spaces between letters; tolerate either form.
    has_regiment = ("3d MLR" in body) or ("3 d M L R" in body)
    has_marforpac = "MARFORPAC" in body
    assert has_regiment and has_marforpac, (
        "PitchVisual UnitIcon no longer shows 3d MLR + MARFORPAC; "
        "the slide-2 visual has drifted from MOCK_USERS."
    )
