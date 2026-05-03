"""LLM-assisted column mapper — uses an injected deterministic stub."""
from __future__ import annotations

import pytest

from backend.uis.adapters.spec import AdapterSpec, ColumnSpec
from backend.uis.mapping.llm_map import (
    LLM_CONFIDENCE_FLOOR,
    LlmMappingProposal,
    propose_mapping_with_llm,
    _parse_llm_response,
)


@pytest.fixture
def ecp_spec():
    return AdapterSpec(
        id="test/ecp",
        target_entity="Asset",
        canonical_columns=[
            ColumnSpec("tamcn", required=True),
            ColumnSpec("nsn"),
            ColumnSpec("serial_number", sensitive=True, hash_prefix="SERIAL_NUMBER"),
            ColumnSpec("nomenclature", description="Equipment description / common name"),
            ColumnSpec("owner_uic", sensitive=True, hash_prefix="OWNER_UIC"),
            ColumnSpec("allowance_qty", type="int", description="T/O&E allowance"),
            ColumnSpec("on_hand_qty", type="int", description="Current on-hand count"),
            ColumnSpec("last_inventory_date", type="date_oracle"),
        ],
        primary_key=["serial_number"],
    )


def _stub_llm(content: str):
    """Build an injectable async caller that returns a fixed response."""
    async def _call(*, messages, **kwargs):
        return {"choices": [{"message": {"content": content}}]}
    return _call


def _stub_llm_raises(exc: Exception):
    async def _call(*, messages, **kwargs):
        raise exc
    return _call


# ---------------------------------------------------------------------------
# Response parser
# ---------------------------------------------------------------------------


def test_parse_response_accepts_plain_json():
    text = '{"mappings": [{"source": "S", "canonical": "C", "confidence": 0.9, "reasoning": "x"}]}'
    out = _parse_llm_response(text)
    assert len(out) == 1
    assert out[0]["source"] == "S"


def test_parse_response_strips_code_fences():
    text = '```json\n{"mappings": [{"source": "S", "canonical": "C", "confidence": 0.9}]}\n```'
    out = _parse_llm_response(text)
    assert len(out) == 1


def test_parse_response_finds_inline_object():
    text = "Here is the mapping I propose: {\"mappings\": []} — that's it."
    out = _parse_llm_response(text)
    assert out == []


def test_parse_response_empty_on_garbage():
    assert _parse_llm_response("nope") == []
    assert _parse_llm_response("") == []


# ---------------------------------------------------------------------------
# Two-stage flow
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_skips_llm_when_auto_baseline_perfect(ecp_spec):
    """All canonical names match exactly → auto-baseline 1.0, LLM not called."""
    headers = ["tamcn", "nsn", "serial_number", "nomenclature", "owner_uic",
               "allowance_qty", "on_hand_qty", "last_inventory_date"]
    sentinel = {"called": False}
    async def stub(*, messages, **kwargs):
        sentinel["called"] = True
        return {"choices": [{"message": {"content": "{}"}}]}
    proposal = await propose_mapping_with_llm(headers, ecp_spec, llm_caller=stub)
    assert sentinel["called"] is False
    assert proposal.llm_invoked is False
    assert proposal.auto_baseline_confidence == 1.0


@pytest.mark.asyncio
async def test_invokes_llm_for_unmapped_tail(ecp_spec):
    """Auto-mapper misses some columns → LLM proposes the rest."""
    headers = [
        "TAMCN",                  # → tamcn (auto)
        "Equipment Description",  # → nomenclature (auto can't, LLM can)
        "On-Hand Count",          # → on_hand_qty (auto can't, LLM can)
        "Allowance",              # → allowance_qty (auto can't, LLM can)
    ]
    llm_response = (
        '{"mappings": ['
        '{"source": "Equipment Description", "canonical": "nomenclature", "confidence": 0.95, "reasoning": "common name field"},'
        '{"source": "On-Hand Count", "canonical": "on_hand_qty", "confidence": 0.93, "reasoning": "qty on hand"},'
        '{"source": "Allowance", "canonical": "allowance_qty", "confidence": 0.92, "reasoning": "T/O&E allowance"}'
        "]}"
    )
    proposal = await propose_mapping_with_llm(
        headers, ecp_spec, llm_caller=_stub_llm(llm_response),
    )
    assert proposal.llm_invoked is True
    assert proposal.llm_failed is False
    assert proposal.column_map["Equipment Description"] == "nomenclature"
    assert proposal.column_map["On-Hand Count"] == "on_hand_qty"
    assert proposal.column_map["Allowance"] == "allowance_qty"
    # LLM proposals carry per-field reasoning
    assert "common name" in proposal.reasoning_per_field["nomenclature"]


@pytest.mark.asyncio
async def test_llm_cannot_overwrite_auto_mapping(ecp_spec):
    """Even if the LLM tries to remap a column the auto-mapper already
    confirmed, the auto wins."""
    headers = ["TAMCN", "Equipment Description"]
    llm_response = (
        '{"mappings": ['
        '{"source": "TAMCN", "canonical": "nomenclature", "confidence": 0.99, "reasoning": "wrong on purpose"},'
        '{"source": "Equipment Description", "canonical": "nomenclature", "confidence": 0.9, "reasoning": "ok"}'
        "]}"
    )
    proposal = await propose_mapping_with_llm(
        headers, ecp_spec, llm_caller=_stub_llm(llm_response),
    )
    # auto-mapper claims TAMCN → tamcn and locks it
    assert proposal.column_map["TAMCN"] == "tamcn"
    # LLM's bogus TAMCN → nomenclature is rejected because TAMCN
    # is no longer in unmapped_source
    # Equipment Description correctly maps to nomenclature
    assert proposal.column_map.get("Equipment Description") == "nomenclature"


@pytest.mark.asyncio
async def test_llm_proposes_unknown_source_or_canonical_ignored(ecp_spec):
    """The LLM occasionally hallucinates column names. Drop those mappings."""
    headers = ["Foo", "Bar"]
    llm_response = (
        '{"mappings": ['
        '{"source": "Ghost", "canonical": "tamcn", "confidence": 0.99, "reasoning": "made up"},'
        '{"source": "Foo", "canonical": "fake_field", "confidence": 0.9, "reasoning": "also made up"}'
        "]}"
    )
    proposal = await propose_mapping_with_llm(
        headers, ecp_spec, llm_caller=_stub_llm(llm_response),
    )
    # Neither hallucinated mapping accepted
    assert proposal.column_map == {}
    assert "tamcn" in proposal.unmapped_canonical


@pytest.mark.asyncio
async def test_llm_failure_falls_back_to_auto_only(ecp_spec):
    """LLM exception → graceful degradation, auto-mapper baseline stands."""
    headers = ["TAMCN", "Equipment Description"]
    proposal = await propose_mapping_with_llm(
        headers, ecp_spec, llm_caller=_stub_llm_raises(RuntimeError("LLM 503")),
    )
    assert proposal.llm_failed is True
    assert "LLM 503" in (proposal.llm_failure_reason or "")
    # auto-mapper still claimed TAMCN
    assert proposal.column_map.get("TAMCN") == "tamcn"


@pytest.mark.asyncio
async def test_llm_empty_response_marked_failed(ecp_spec):
    headers = ["Equipment Description"]
    proposal = await propose_mapping_with_llm(
        headers, ecp_spec, llm_caller=_stub_llm(""),
    )
    assert proposal.llm_invoked is True
    assert proposal.llm_failed is True


@pytest.mark.asyncio
async def test_llm_garbage_response_marked_failed(ecp_spec):
    headers = ["Equipment Description"]
    proposal = await propose_mapping_with_llm(
        headers, ecp_spec, llm_caller=_stub_llm("not json at all"),
    )
    assert proposal.llm_failed is True
    assert "parseable" in (proposal.llm_failure_reason or "").lower()


@pytest.mark.asyncio
async def test_llm_with_sample_rows_passes_them_to_caller(ecp_spec):
    """Sample rows make it into the user message for context."""
    captured = {}
    async def stub(*, messages, **kwargs):
        captured["messages"] = messages
        return {"choices": [{"message": {"content": "{}"}}]}
    headers = ["Foo"]
    sample = [{"Foo": "12345"}, {"Foo": "67890"}]
    await propose_mapping_with_llm(headers, ecp_spec, sample, llm_caller=stub)
    user_text = next(m["content"] for m in captured["messages"] if m["role"] == "user")
    assert "12345" in user_text


@pytest.mark.asyncio
async def test_mapped_sensitive_columns_never_sent_to_llm(ecp_spec):
    """When the auto-mapper has already claimed SERIAL_NUMBER →
    serial_number, that source column is no longer in unmapped_source
    so the prompt builder never includes its values. Defense-in-depth:
    the redaction layer would also catch it, but the primary guard is
    the prompt itself only looking at unmapped columns."""
    captured = {}
    async def stub(*, messages, **kwargs):
        captured["user_text"] = next(
            m["content"] for m in messages if m["role"] == "user"
        )
        return {"choices": [{"message": {"content": "{}"}}]}

    headers = ["TAMCN", "SERIAL_NUMBER", "FooDescription"]
    sample = [
        {"TAMCN": "D1196", "SERIAL_NUMBER": "JLTV-001234-clear", "FooDescription": "JLTV"},
    ]
    await propose_mapping_with_llm(headers, ecp_spec, sample, llm_caller=stub)
    user_text = captured.get("user_text", "")
    # The clear serial value must NOT appear in the prompt
    assert "JLTV-001234-clear" not in user_text
    # SERIAL_NUMBER is the source column name; doesn't appear in
    # unmapped_source either (already mapped) so absent from prompt
    assert "SERIAL_NUMBER" not in user_text or "<redacted>" in user_text


@pytest.mark.asyncio
async def test_sample_rows_redact_heuristic_sensitive_columns(ecp_spec):
    """Source columns NOT yet mapped but whose name contains a
    sensitive token (SSN, EDIPI, DODID, SERIAL, UIC, NAME, ADDRESS)
    have their values redacted heuristically. Catches the
    pre-sanitization-upload case."""
    captured = {}
    async def stub(*, messages, **kwargs):
        captured["user_text"] = next(
            m["content"] for m in messages if m["role"] == "user"
        )
        return {"choices": [{"message": {"content": "{}"}}]}

    # An unrecognized export — auto-mapper catches nothing — but
    # has columns whose names match sensitive tokens.
    headers = ["UnitName", "SSN", "Address1", "RandomCol"]
    sample = [{
        "UnitName": "GySgt John Smith",
        "SSN": "123-45-6789",
        "Address1": "123 Main St",
        "RandomCol": "non-sensitive",
    }]
    await propose_mapping_with_llm(headers, ecp_spec, sample, llm_caller=stub)
    user_text = captured.get("user_text", "")
    assert "John Smith" not in user_text
    assert "123-45-6789" not in user_text
    assert "123 Main St" not in user_text
    # Non-sensitive col passes through
    assert "non-sensitive" in user_text


@pytest.mark.asyncio
async def test_no_sample_rows_no_redaction_path(ecp_spec):
    """When sample_rows=None the redaction path is a noop."""
    async def stub(*, messages, **kwargs):
        return {"choices": [{"message": {"content": "{}"}}]}
    headers = ["UnknownCol"]
    proposal = await propose_mapping_with_llm(headers, ecp_spec, None, llm_caller=stub)
    # No crash; LLM still gets the column-name hint
    assert proposal.llm_invoked is True


@pytest.mark.asyncio
async def test_llm_confidence_clamped_to_unit_interval(ecp_spec):
    """If the LLM hallucinates confidence>1 or negative, clamp to [0,1]."""
    headers = ["Description"]
    llm_response = (
        '{"mappings": ['
        '{"source": "Description", "canonical": "nomenclature", "confidence": 1.5, "reasoning": "x"}'
        "]}"
    )
    proposal = await propose_mapping_with_llm(
        headers, ecp_spec, llm_caller=_stub_llm(llm_response),
    )
    assert proposal.confidence_per_field["nomenclature"] <= 1.0
