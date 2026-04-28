"""Task #194 — SPIRO brevity / persona prompt tests.

These tests assert the SYSTEM_PROMPT in `backend.copilot.planner` carries the
Marine brevity vocabulary block, the tone block, and the refusal templates
the live demo voice depends on. They DO NOT make LLM calls — they validate
the prompt shape so any drift to the persona is caught at CI time, not on
stage in front of MDM 2026 reviewers.
"""
from __future__ import annotations

import pytest

from backend.copilot.planner import SYSTEM_PROMPT


# 15 brevity / tone phrases the demo persona MUST own. Drift (e.g. someone
# softens "Negative" to "Sorry, no") shows up as a fail with the missing
# phrase named.
BREVITY_PHRASES = [
    "Affirmative",
    "Negative",
    "Roger",
    "Stand by",
    "Wilco",
    "Copy",
    "Out",
    "Off scope",
    "Tracking",
    "Bingo",
    "Winchester",
    "SITREP",
    "BLUF",
    "Back-brief",
    "Charlie Mike",
    "Oscar Mike",
]

TONE_RULES = [
    "24-hour time",
    "No emojis",
    "No apologies",
    "No filler",
    "off scope",
    "above my authority",
]

# Hard prohibitions: no Anthropic / Claude attribution, no Thornveil IP
# disclosure leaking into the persona prompt.
FORBIDDEN_TERMS = [
    "Anthropic",
    "anthropic",
    "Claude",
    "claude",
    "Thornveil",
    "thornveil",
    "OpenAI",
    "GPT-4",
    "GPT-5",
]


@pytest.mark.parametrize("phrase", BREVITY_PHRASES)
def test_brevity_phrase_present(phrase: str):
    assert phrase in SYSTEM_PROMPT, (
        f"SPIRO persona drift — '{phrase}' missing from SYSTEM_PROMPT"
    )


@pytest.mark.parametrize("rule", TONE_RULES)
def test_tone_rule_present(rule: str):
    assert rule.lower() in SYSTEM_PROMPT.lower(), (
        f"SPIRO tone drift — '{rule}' missing from SYSTEM_PROMPT"
    )


@pytest.mark.parametrize("term", FORBIDDEN_TERMS)
def test_forbidden_term_absent(term: str):
    assert term not in SYSTEM_PROMPT, (
        f"SPIRO leaked forbidden term '{term}' into SYSTEM_PROMPT"
    )


def test_refusal_templates_present():
    """The four refusal shapes must be intact, verbatim or close enough that
    the persona has the off-scope / above-authority / missing-data /
    refused-speculation patterns to reach for at runtime."""
    refusals = [
        "Negative — off scope",
        "above my authority",
        "Stand by — I need",
        "won't speculate",
    ]
    for r in refusals:
        assert r in SYSTEM_PROMPT, f"refusal template missing: {r}"


def test_marine_brevity_section_header():
    assert "MARINE BREVITY" in SYSTEM_PROMPT
    assert "TONE" in SYSTEM_PROMPT
    assert "REFUSAL TEMPLATE" in SYSTEM_PROMPT
