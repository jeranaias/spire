"""Fixed-width record streamer.

Mainframe COBOL exports + DoD legacy systems often emit fixed-width
flat files. Each line is a record; columns are identified by
character positions, not delimiters.

Layout shape
------------
The adapter declares a list of column positions::

    AdapterSpec(
        ...,
        format_hint="fixed_width",
        fixed_width_spec=FixedWidthSpec(
            columns=[
                FixedWidthColumn(name="ASSET_ID",      start=0,  length=12),
                FixedWidthColumn(name="TAMCN",         start=12, length=8),
                FixedWidthColumn(name="STATUS",        start=20, length=4),
                FixedWidthColumn(name="HOURS",         start=24, length=8),
            ],
            skip_leading_lines=1,    # skip a header banner if present
            skip_trailing_lines=0,
        ),
    )

The streamer reads each line, slices by (start, length), strips
trailing spaces (mainframe pads with spaces), yields a dict.

Why explicit positions instead of inference: real-world fixed-
width files don't have headers — you can't tell where column N
ends without knowing the spec. So adapters always declare it.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterator, List


@dataclass
class FixedWidthColumn:
    """Single column position in a fixed-width record."""

    name: str
    start: int   # 0-indexed character offset
    length: int  # number of characters
    strip: str = "right"  # "right" / "both" / "none" — how to strip padding


@dataclass
class FixedWidthSpec:
    """Adapter-supplied layout for a fixed-width file.

    ``encoding`` defaults to "utf-8"; mainframe exports are often
    cp1047 (EBCDIC) or ASCII. Adapter overrides as needed.

    ``record_length`` (optional) is the expected total bytes per
    record. When set, the streamer asserts each line matches and
    surfaces a warning if not — a tripwire against unexpected
    schema drift.
    """

    columns: List[FixedWidthColumn] = field(default_factory=list)
    encoding: str = "utf-8"
    skip_leading_lines: int = 0
    skip_trailing_lines: int = 0
    record_length: int = 0  # 0 = no length check
    line_separator: str = "\n"  # rare COBOL exports use CR or just \r


def stream_fixed_width(
    raw: bytes,
    spec: FixedWidthSpec,
) -> Iterator[dict]:
    """Yield one dict per fixed-width record line."""
    if not spec.columns:
        raise ValueError("FixedWidthSpec must declare at least one column")
    try:
        text = raw.decode(spec.encoding, errors="replace")
    except LookupError as e:
        raise ValueError(
            f"Unknown encoding {spec.encoding!r} declared in FixedWidthSpec"
        ) from e
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split(spec.line_separator)
    # Remove trailing blank line(s) artifact of split-on-newline
    while lines and not lines[-1]:
        lines.pop()

    if spec.skip_leading_lines:
        lines = lines[spec.skip_leading_lines:]
    if spec.skip_trailing_lines:
        lines = lines[: -spec.skip_trailing_lines] if spec.skip_trailing_lines < len(lines) else []

    for line in lines:
        if not line.strip():
            continue  # skip blank lines (mainframe sometimes pads)
        if spec.record_length and len(line) != spec.record_length:
            # Length mismatch — yield with a warning column the
            # adapter can spot at validation time. Don't drop —
            # operator might have intentional schema drift.
            row: dict = {"_record_length_mismatch": str(len(line))}
        else:
            row = {}
        for col in spec.columns:
            raw_value = line[col.start: col.start + col.length] if col.start < len(line) else ""
            if col.strip == "right":
                value = raw_value.rstrip()
            elif col.strip == "both":
                value = raw_value.strip()
            else:
                value = raw_value
            row[col.name] = value
        yield row
