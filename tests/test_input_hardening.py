"""Input/upload hardening: XXE + archive bomb/traversal (P2-4)."""
from __future__ import annotations

import io
import tarfile
from pathlib import Path

import pytest

from backend.uis import dr
from backend.uis.formats import xml_format


def test_benign_xml_parses():
    rows = list(xml_format.stream_xml(b"<root><r><a>1</a></r><r><a>2</a></r></root>"))
    assert len(rows) == 2


def test_xxe_external_entity_is_refused():
    xxe = (
        b'<?xml version="1.0"?>'
        b'<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>'
        b"<root><r><a>&x;</a></r></root>"
    )
    ET, defused = xml_format._import_etree()
    if not defused:
        pytest.skip("defusedxml not installed in this env")
    with pytest.raises(Exception):  # defusedxml.EntitiesForbidden
        list(xml_format.stream_xml(xxe))


def _tar_with_member(name: str, size: int) -> tarfile.TarFile:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as t:
        info = tarfile.TarInfo(name)
        info.size = size
        t.addfile(info, io.BytesIO(b"\x00" * size))
    buf.seek(0)
    return tarfile.open(fileobj=buf, mode="r")


def test_oversized_archive_rejected(monkeypatch, tmp_path):
    monkeypatch.setattr(dr, "MAX_EXTRACT_BYTES", 1024)  # 1 KB cap for the test
    tar = _tar_with_member("spire.db", size=10 * 1024)   # header claims 10 KB
    with pytest.raises(ValueError, match="extract cap"):
        dr._safe_extract(tar, tmp_path, allowed=["spire.db"])


def test_unexpected_member_rejected(tmp_path):
    tar = _tar_with_member("evil.sh", size=10)
    with pytest.raises(ValueError, match="unexpected archive member"):
        dr._safe_extract(tar, tmp_path, allowed=["spire.db"])
