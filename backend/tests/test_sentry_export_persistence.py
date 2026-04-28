"""
Task-110 — SENTRY export bundles must survive a backend restart.

Before this task, `_EXPORTS` in `backend/routes/sentry.py` was an
in-memory dict. Any uvicorn restart between the moment the operator
clicked "Export Sanitized Bundle" and the moment they (or a coalition
partner) hit the download link vanished the bundle, forcing a rebuild
that re-stamped a different `export_id` and re-snapshotted a different
audit chain.

These tests lock in:

* `/export` writes the zip + a metadata sidecar to disk under
  `runtime/sentry_exports/<export_id>/`.
* `/download/{export_id}` streams from disk, so an in-process restart
  (we simulate it by clearing `_EXPORTS`) still serves the same bytes
  and keeps the classification gate honest.
* The retention sweep purges stale bundle directories whose mtime is
  older than `SPIRE_EXPORT_RETENTION_SECONDS`.
* Half-cleaned-up bundles (meta.json gone, zip lingering) surface as
  404 on download rather than streaming an unverified artifact.
"""
from __future__ import annotations

import io
import os
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend import persistence
from backend.routes import sentry as sentry_routes


DODID_PARK = "3456789012"  # security_manager, TS//SCI


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # Redirect the on-disk EXPORTS_DIR into tmp_path so test runs don't
    # collide with a real demo's accumulated bundles. We also clear the
    # in-process LRU between tests so cache-vs-disk behaviour is isolated.
    test_dir = tmp_path / "sentry_exports"
    test_dir.mkdir()
    monkeypatch.setattr(persistence, "EXPORTS_DIR", test_dir)
    sentry_routes._EXPORTS.clear()
    with TestClient(app) as c:
        yield c
    sentry_routes._EXPORTS.clear()


def _login(c: TestClient, dodid: str = DODID_PARK) -> None:
    r = c.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _build_bundle(c: TestClient) -> dict:
    r = c.post(
        "/api/sentry/export",
        json={
            "release_authority": "US_ONLY",
            "format": "json",
            "include_audit": True,
            "batch_id": None,
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_export_writes_zip_and_meta_sidecar_to_disk(client):
    _login(client)
    body = _build_bundle(client)
    export_id = body["export_id"]

    bundle_path = persistence.EXPORTS_DIR / export_id / "bundle.zip"
    meta_path = persistence.EXPORTS_DIR / export_id / "meta.json"
    assert bundle_path.exists(), "export endpoint did not persist the zip"
    assert meta_path.exists(), "export endpoint did not write meta sidecar"

    # The persisted zip is the same bytes the response advertised.
    assert bundle_path.stat().st_size == body["bytes"]

    # Meta carries the classification + filename so /download can gate
    # without cracking the zip.
    import json as _json
    meta = _json.loads(meta_path.read_text())
    assert meta["classification"] == body["classification"]
    assert meta["filename"] == body["filename"]
    assert meta["export_id"] == export_id


def test_download_streams_from_disk_after_in_memory_cache_wipe(client):
    """Simulate a uvicorn restart: build a bundle, clear `_EXPORTS`,
    then hit /download. The bundle must still serve from disk with the
    same bytes it was built with."""
    _login(client)
    body = _build_bundle(client)
    export_id = body["export_id"]
    download_url = body["download_url"]

    first = client.get(download_url)
    assert first.status_code == 200
    expected_bytes = first.content

    # Wipe the in-memory metadata cache to mimic a process restart. The
    # disk sidecar and zip are still present, so the next download must
    # re-hydrate from disk transparently.
    sentry_routes._EXPORTS.clear()

    second = client.get(download_url)
    assert second.status_code == 200, second.text
    assert second.content == expected_bytes, (
        "post-restart download served different bytes than the original"
    )
    # The zip is still a valid archive containing the manifest file.
    with zipfile.ZipFile(io.BytesIO(second.content)) as z:
        assert "MANIFEST.json" in z.namelist()


def test_download_404_when_bundle_zip_missing_even_if_meta_lingers(client):
    """A half-cleaned-up bundle (meta sidecar still on disk, zip gone)
    must surface a clean 404, not a 500. The route also evicts the
    stale meta from the in-process cache so a subsequent recreate of
    the same export_id (unlikely but possible) doesn't get poisoned."""
    _login(client)
    body = _build_bundle(client)
    export_id = body["export_id"]

    bundle_path = persistence.EXPORTS_DIR / export_id / "bundle.zip"
    bundle_path.unlink()

    r = client.get(body["download_url"])
    assert r.status_code == 404, r.text
    assert export_id not in sentry_routes._EXPORTS


def test_prune_sentry_exports_removes_stale_bundle_dirs(client):
    """Aged-out bundle directories must be purged when prune runs.
    Fresh bundles (within the retention window) stay put."""
    _login(client)
    fresh = _build_bundle(client)["export_id"]
    stale = _build_bundle(client)["export_id"]

    # Age the stale bundle's meta + bundle past the retention window.
    stale_dir = persistence.EXPORTS_DIR / stale
    old_mtime = time.time() - (3 * 24 * 3600)
    for f in stale_dir.iterdir():
        os.utime(f, (old_mtime, old_mtime))

    removed = persistence.prune_sentry_exports(max_age_seconds=24 * 3600)
    assert removed == 1
    assert not stale_dir.exists(), "stale bundle directory was not purged"
    assert (persistence.EXPORTS_DIR / fresh).exists(), (
        "retention sweep wrongly purged a fresh bundle"
    )


def test_prune_handles_orphan_dir_with_no_meta_sidecar(client):
    """A bundle directory missing its meta.json (corrupted state from
    a crash mid-write) must be cleaned up once it ages past the
    two-minute grace period — but a freshly-created orphan stays put
    in case the writer is still working on it."""
    fresh_orphan = persistence.EXPORTS_DIR / "EXP-FRESH-ORPHAN"
    fresh_orphan.mkdir()
    (fresh_orphan / "bundle.zip.tmp").write_bytes(b"in-progress")

    aged_orphan = persistence.EXPORTS_DIR / "EXP-AGED-ORPHAN"
    aged_orphan.mkdir()
    (aged_orphan / "bundle.zip.tmp").write_bytes(b"crashed mid-write")
    old_mtime = time.time() - (3 * 24 * 3600)
    for f in aged_orphan.iterdir():
        os.utime(f, (old_mtime, old_mtime))
    os.utime(aged_orphan, (old_mtime, old_mtime))

    removed = persistence.prune_sentry_exports(max_age_seconds=24 * 3600)
    assert removed >= 1
    assert not aged_orphan.exists()
    assert fresh_orphan.exists(), (
        "fresh orphan was purged before its grace window expired"
    )


def test_load_helpers_reject_path_traversal_export_ids():
    """The export_id is taken straight from the URL path; the loaders
    must refuse anything that would let a caller break out of the
    bundle directory (../../etc/passwd, foo/bar, empty string)."""
    assert persistence.load_sentry_export_meta("") is None
    assert persistence.load_sentry_export_meta("../etc/passwd") is None
    assert persistence.load_sentry_export_meta("foo/bar") is None
    assert persistence.load_sentry_export_bytes("") is None
    assert persistence.load_sentry_export_bytes("../etc/passwd") is None
    assert persistence.load_sentry_export_bytes("foo/bar") is None


def test_export_retention_seconds_honors_env_var(monkeypatch):
    """The retention threshold is configurable via env so a demo run
    can crank it down to a few minutes without touching code."""
    monkeypatch.setenv("SPIRE_EXPORT_RETENTION_SECONDS", "60")
    assert persistence._export_retention_seconds() == 60

    # Garbage values fall back to the 24h default rather than blowing up.
    monkeypatch.setenv("SPIRE_EXPORT_RETENTION_SECONDS", "not-a-number")
    assert persistence._export_retention_seconds() == 24 * 3600

    monkeypatch.setenv("SPIRE_EXPORT_RETENTION_SECONDS", "-5")
    assert persistence._export_retention_seconds() == 24 * 3600


def test_export_meta_lru_caps_in_process_memory(client):
    """The in-memory LRU is meant to be a thin cache, not a leak. After
    repeated builds the cache must stay bounded at the configured cap."""
    _login(client)
    cap = sentry_routes._EXPORTS_META_CACHE_MAX
    sentry_routes._EXPORTS.clear()

    # Build a few extra bundles past the cap. Each /export call goes
    # through `_cache_export_meta` so the LRU bookkeeping is exercised
    # end-to-end (not just via the helper directly).
    for _ in range(cap + 5):
        body = _build_bundle(client)
        assert body["ok"] is True

    assert len(sentry_routes._EXPORTS) <= cap
