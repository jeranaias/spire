"""XML row streamer.

Converts a typical "list-of-records" XML document into row-of-dicts.
Two shapes are recognized:

  1. **Repeated child elements** under a root::

         <Records>
             <Record>
                 <SR_NUMBER>SR-1</SR_NUMBER>
                 <PRIORITY>02</PRIORITY>
             </Record>
             <Record>
                 <SR_NUMBER>SR-2</SR_NUMBER>
                 <PRIORITY>03</PRIORITY>
             </Record>
         </Records>

     Each ``<Record>`` becomes one row; leaf children become columns.

  2. **NIEM-style flat ext:Items** with same-named children — same
     as (1), the streamer auto-detects the most common child tag
     under the root and treats those as records.

Attributes on a record element are merged into the dict using an
``@attr_<name>`` key prefix so they don't collide with element-named
columns. Mixed-content (text + children) is rare in DoD logistics
schemas; if encountered, the text is stored under a ``#text`` key.

Defensive parsing
-----------------
Uses ``defusedxml.ElementTree`` if available (preferred — protects
against billion-laughs / external-entity attacks). Falls back to
stdlib ``xml.etree.ElementTree`` with a warning logged. Production
deployments should `pip install defusedxml`.

Namespaces
----------
Tags carrying XML namespaces (``{http://niem...}Record``) are
stripped to their local part for column-name purposes; the full
NS-qualified tag is recorded once under ``@xmlns_<prefix>`` if
the operator wants to inspect.
"""
from __future__ import annotations

import logging
from collections import Counter
from typing import Any, Dict, Iterator, List, Optional


log = logging.getLogger(__name__)


def _import_etree():
    """Prefer defusedxml; warn-and-fallback to stdlib if not installed."""
    try:
        import defusedxml.ElementTree as ET  # type: ignore
        return ET, True
    except ImportError:
        import xml.etree.ElementTree as ET
        log.warning(
            "defusedxml not installed — using stdlib xml.etree. "
            "Install defusedxml for hardening: pip install defusedxml"
        )
        return ET, False


def stream_xml(raw: bytes) -> Iterator[Dict[str, str]]:
    """Yield one dict per record element under the document root."""
    ET, _is_defused = _import_etree()
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        # Surface as an empty stream + caller's pipeline will produce
        # zero rows. The stream-error path in the runner audits this.
        log.warning("XML parse error: %s", e)
        return iter(())

    # Find the most common child tag — that's the record element
    children = list(root)
    if not children:
        return iter(())
    record_tag = _most_common_tag(children)

    out: List[Dict[str, str]] = []
    for child in children:
        if _local_name(child.tag) != _local_name(record_tag):
            continue
        out.append(_record_to_dict(child))
    return iter(out)


def _most_common_tag(children) -> str:
    counter = Counter(c.tag for c in children)
    # most_common(1) returns [(tag, count)]
    return counter.most_common(1)[0][0]


def _local_name(tag: str) -> str:
    """Strip XML namespace from a tag::

        {http://niem...}Record  →  Record
    """
    if tag and tag.startswith("{") and "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def _record_to_dict(elem) -> Dict[str, str]:
    """Convert one XML element to a flat dict of strings.

    Children are leaf-flattened: ``<SR><Priority>02</Priority></SR>``
    yields ``{"Priority": "02"}``. Nested non-leaf children get their
    text concatenated (rare in DoD schemas).
    """
    row: Dict[str, str] = {}
    # Attributes on the record element become @attr_<name> columns
    for attr_name, attr_value in elem.attrib.items():
        row[f"@attr_{_local_name(attr_name)}"] = (attr_value or "").strip()
    # Mixed content
    if elem.text and elem.text.strip():
        row["#text"] = elem.text.strip()
    for child in elem:
        col = _local_name(child.tag)
        # Leaf — text content
        if not list(child):
            value = (child.text or "").strip()
            row[col] = value
        else:
            # Non-leaf — concatenate descendant text. Rare in
            # logistics schemas, but better than dropping.
            row[col] = " ".join(_iter_text(child)).strip()
    return row


def _iter_text(elem) -> List[str]:
    parts: List[str] = []
    if elem.text and elem.text.strip():
        parts.append(elem.text.strip())
    for child in elem:
        parts.extend(_iter_text(child))
        if child.tail and child.tail.strip():
            parts.append(child.tail.strip())
    return parts
