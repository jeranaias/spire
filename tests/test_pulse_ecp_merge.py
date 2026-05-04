"""Tests for the GCSS-MC ECP merge diff engine."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from backend.integrations.pulse_gcss_ecp_adapter import ParsedAssetRow
from backend.integrations.pulse_gcss_ecp_merge import (
    MergeDiff,
    apply_diff,
    compute_diff,
    diff_to_payload,
)


@dataclass
class FakeAsset:
    """Minimal duck-typed Asset for diff testing.

    Includes the ECP-only roster fields (RD6a) so `apply_diff` has
    somewhere to write when the dry-run says they should land.
    """

    asset_id: str
    serial_number: str
    tamcn: str
    nsn: str
    unit_uic: str
    nomenclature: str = ""
    allowance_qty: int = 0
    on_hand_qty: int = 0
    last_inventory_date: date | None = None


def _row(
    *,
    tamcn: str = "D1196",
    serial: str = "owner_serial_aBcDeFgHiJkLmNoPqRsT",
    serial_src: str = "pre_hashed",
    nomenclature: str = "JLTV",
    owner_uic: str = "owner_uic_zZyYxXwWvVuUtTsSrRqQ",
    owner_uic_src: str = "pre_hashed",
    nsn: str = "2320-01-540-2480",
    allowance: int = 15,
    on_hand: int = 12,
    last_inv: date | None = None,
) -> ParsedAssetRow:
    return ParsedAssetRow(
        tamcn=tamcn,
        nsn=nsn,
        serial_number=serial,
        serial_number_source=serial_src,
        nomenclature=nomenclature,
        owner_uic=owner_uic,
        owner_uic_source=owner_uic_src,
        allowance_qty=allowance,
        on_hand_qty=on_hand,
        last_inventory_date=last_inv,
    )


def _asset(
    *,
    asset_id: str = "M21670-MTVR_CARGO-006",
    serial: str = "owner_serial_aBcDeFgHiJkLmNoPqRsT",
    tamcn: str = "D1196",
    nsn: str = "2320-01-540-2480",
    unit_uic: str = "owner_uic_zZyYxXwWvVuUtTsSrRqQ",
    nomenclature: str = "JLTV",
) -> FakeAsset:
    return FakeAsset(
        asset_id=asset_id,
        serial_number=serial,
        tamcn=tamcn,
        nsn=nsn,
        unit_uic=unit_uic,
        nomenclature=nomenclature,
    )


def test_aligned_row_only_surfaces_ecp_only_field_changes():
    """When roster fields all match, the row still lands in `matched` if
    the ECP carries fields the canonical schema doesn't yet store
    (allowance_qty, on_hand_qty, last_inventory_date). Those are
    surfaced for schema-extension review at apply time. With NO
    ECP-only fields on the row, the alignment goes to `unchanged`."""
    # All roster fields aligned, no ECP-only values — true unchanged.
    row = _row(allowance=0, on_hand=0, last_inv=None)
    asset = _asset()
    diff = compute_diff([row], [asset])
    counts = diff.counts()
    assert counts["unchanged"] == 1
    assert counts["matched_changed"] == 0


def test_aligned_row_with_ecp_only_fields_lands_in_matched():
    """ECP-only field values always surface as proposed changes."""
    row = _row(allowance=15, on_hand=12, last_inv=date(2026, 3, 12))
    asset = _asset()
    diff = compute_diff([row], [asset])
    fields_changed = {c.field for c in diff.matched[0].changes}
    assert fields_changed == {"allowance_qty", "on_hand_qty", "last_inventory_date"}


def test_matched_with_field_change_lands_in_matched_not_unchanged():
    row = _row(nomenclature="JOINT LIGHT TACTICAL VEHICLE")
    asset = _asset(nomenclature="JLTV")
    diff = compute_diff([row], [asset])
    counts = diff.counts()
    assert counts["matched_changed"] == 1
    assert counts["unchanged"] == 0
    assert any(c.field == "nomenclature" for c in diff.matched[0].changes)


def test_new_row_when_no_match():
    row = _row(serial="owner_serial_unknown_aaaaaaaaaaaaaaaaaaaa")
    asset = _asset()  # different serial
    diff = compute_diff([row], [asset])
    counts = diff.counts()
    assert counts["new"] == 1
    assert counts["unchanged"] == 0
    assert counts["matched_changed"] == 0
    assert counts["stale"] == 1  # the existing asset wasn't in the file


def test_stale_asset_when_canonical_has_no_corresponding_row():
    asset_in_file = _asset(asset_id="A-1", serial="serial_a")
    asset_only_canonical = _asset(asset_id="A-2", serial="serial_b")
    row = _row(serial="serial_a")
    diff = compute_diff([row], [asset_in_file, asset_only_canonical])
    counts = diff.counts()
    assert counts["stale"] == 1
    assert diff.stale[0].asset_id == "A-2"


def test_conflict_when_serial_matches_multiple_assets():
    """Duplicate serial across two assets is the file-quality smoking gun."""
    a1 = _asset(asset_id="A-1", serial="dup_serial")
    a2 = _asset(asset_id="A-2", serial="dup_serial")
    row = _row(serial="dup_serial")
    diff = compute_diff([row], [a1, a2])
    counts = diff.counts()
    assert counts["conflicts"] == 1
    assert sorted(diff.conflicts[0].candidate_asset_ids) == ["A-1", "A-2"]


def test_tuple_fallback_when_serial_missing_from_file():
    """Row without serial falls back to (TAMCN, OWNER_UIC) tuple match."""
    row = _row(serial="", serial_src="missing")
    asset = _asset()
    diff = compute_diff([row], [asset])
    counts = diff.counts()
    # Tuple match — same TAMCN + UIC → the asset matches
    assert counts["matched_changed"] + counts["unchanged"] == 1
    matched = (diff.matched + diff.unchanged)[0]
    assert matched.match_method == "tamcn_uic_tuple"


def test_payload_caps_samples():
    """diff_to_payload caps each list at max_samples."""
    rows = [_row(serial=f"unmatched_serial_{i:020d}") for i in range(15)]
    diff = compute_diff(rows, [_asset()])
    payload = diff_to_payload(diff, max_samples=5)
    assert len(payload["new"]) == 5
    # Counts still reflect the full set
    assert payload["counts"]["new"] == 15


def test_payload_serializes_field_changes():
    row = _row(nomenclature="FULL NAME")
    asset = _asset(nomenclature="SHORT")
    diff = compute_diff([row], [asset])
    payload = diff_to_payload(diff)
    assert payload["matched_changed"][0]["asset_id"] == "M21670-MTVR_CARGO-006"
    fields_changed = [c["field"] for c in payload["matched_changed"][0]["changes"]]
    assert "nomenclature" in fields_changed


def test_empty_inputs_produce_empty_diff():
    diff = compute_diff([], [])
    assert diff.counts() == {
        "matched_changed": 0,
        "new": 0,
        "unchanged": 0,
        "stale": 0,
        "conflicts": 0,
    }


def test_apply_diff_writes_ecp_only_fields_to_matched_asset():
    """apply_diff mutates the matched asset's ECP-only fields in place
    and returns a list reflecting the new state."""
    row = _row(allowance=15, on_hand=12, last_inv=date(2026, 3, 12))
    asset = _asset()  # default ECP-only fields are 0/None
    diff = compute_diff([row], [asset])
    new_assets = apply_diff(diff, [asset])
    assert len(new_assets) == 1
    a = new_assets[0]
    assert a.allowance_qty == 15
    assert a.on_hand_qty == 12
    assert a.last_inventory_date == date(2026, 3, 12)


def test_apply_diff_preserves_unchanged_assets():
    """Apply with no diff is a no-op on the asset list."""
    row = _row(allowance=0, on_hand=0, last_inv=None)
    asset = _asset()
    diff = compute_diff([row], [asset])
    new_assets = apply_diff(diff, [asset])
    assert new_assets[0].allowance_qty == 0
    assert new_assets[0].on_hand_qty == 0
    assert new_assets[0].last_inventory_date is None


def test_apply_diff_appends_new_rows_when_factory_supplied():
    """A `new` row is appended via the factory; without a factory, dropped."""
    row = _row(serial="owner_serial_unique_zzzzzzzzzzzzzzzzzzzz")
    asset = _asset()
    diff = compute_diff([row], [asset])

    # Without factory: stays at 1 (the original asset)
    new_assets = apply_diff(diff, [asset])
    assert len(new_assets) == 1

    # With factory: 2 (original + new from row)
    def factory(parsed):
        return FakeAsset(
            asset_id=f"new-{parsed.serial_number[-6:]}",
            serial_number=parsed.serial_number,
            tamcn=parsed.tamcn,
            nsn=parsed.nsn,
            unit_uic=parsed.owner_uic,
            nomenclature=parsed.nomenclature,
        )
    new_assets = apply_diff(diff, [asset], asset_factory=factory)
    assert len(new_assets) == 2
    assert new_assets[1].asset_id.startswith("new-")


def test_apply_diff_factory_exception_drops_row_safely():
    """An exception in the factory drops the row but doesn't crash apply."""
    row = _row(serial="owner_serial_unique_zzzzzzzzzzzzzzzzzzzz")
    asset = _asset()
    diff = compute_diff([row], [asset])

    def bad_factory(parsed):
        raise ValueError("simulated bad row")

    new_assets = apply_diff(diff, [asset], asset_factory=bad_factory)
    # The original asset is preserved; the bad-factory row is dropped.
    assert len(new_assets) == 1
    assert new_assets[0].asset_id == asset.asset_id


def test_apply_diff_factory_exception_logs_warning(caplog):
    """UIS-30 — bad-factory rows used to disappear silently. The
    apply now logs at WARN level so the backend operator can
    discover them via stderr / journalctl when they notice
    "diff said 5 new, only 3 applied" mismatches."""
    import logging
    row = _row(serial="owner_serial_unique_zzzzzzzzzzzzzzzzzzzz")
    asset = _asset()
    diff = compute_diff([row], [asset])

    def bad_factory(parsed):
        raise ValueError("simulated factory crash for tamcn=" + parsed.tamcn)

    with caplog.at_level(logging.WARNING, logger="backend.integrations.pulse_gcss_ecp_merge"):
        apply_diff(diff, [asset], asset_factory=bad_factory)

    # At least one WARN message naming the factory rejection
    assert any(
        "asset_factory rejected row" in r.message for r in caplog.records
    ), f"caplog: {[r.message for r in caplog.records]}"
