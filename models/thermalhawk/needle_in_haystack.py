"""
Gemma 4 needle-in-haystack validation.

Before we claim "half a million tokens of context -- ask it anything," we
need to verify Gemma 4 actually retrieves from context depth. This script
buries a known fact at various depths in a filler context and asks Gemma 4
to recall it. If retrieval accuracy degrades at depth, the demo pitch gets
adjusted accordingly.

Run after Gemma 4 is back online (post-training window):

  python models/thermalhawk/needle_in_haystack.py \\
      --proxy http://127.0.0.1:8095 \\
      --depths 10000 50000 128000 256000 500000

Outputs a JSON report with retrieval accuracy at each depth.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import httpx


# Filler lorem-ipsum paragraph that we pad to the requested token depth.
FILLER = (
    "Maintenance report segment: vehicle inspected per operator PMCS, fluid levels nominal, "
    "batteries tested within spec, no deficiencies noted, returned to service. "
)


# The "needle" we'll bury -- a specific factual claim the model must recall.
NEEDLE_TEMPLATE = (
    "IMPORTANT FACT: JLTV serial number USMC-ZZ-47392 at {unit} is currently at {hours} operating "
    "hours with a risk score of {risk}. The contributing factors are {factor}."
)


TEST_CASES = [
    {"id": "A", "unit": "CLB-6",        "hours": 18450, "risk": 84, "factor": "transmission fault twice in 90 days"},
    {"id": "B", "unit": "CLB-1",        "hours": 22100, "risk": 91, "factor": "turbocharger actuator seizure risk"},
    {"id": "C", "unit": "5/11 Marines", "hours":  8740, "risk": 67, "factor": "HIMARS launcher rail alignment degradation"},
]


def token_estimate(text: str) -> int:
    return max(1, len(text) // 4)


def build_context(needle_text: str, target_tokens: int, position: str = "middle") -> str:
    """Pad with filler paragraphs around the needle to hit the target token depth.

    position: 'start' | 'middle' | 'end' -- where in the context the needle lands.
    """
    target_chars = target_tokens * 4
    needle_chars = len(needle_text)
    filler_chars = max(0, target_chars - needle_chars)

    if position == "start":
        pre, post = 0, filler_chars
    elif position == "end":
        pre, post = filler_chars, 0
    else:
        pre = filler_chars // 2
        post = filler_chars - pre

    pre_text = (FILLER * (pre // len(FILLER) + 1))[:pre]
    post_text = (FILLER * (post // len(FILLER) + 1))[:post]
    return f"{pre_text}\n\n{needle_text}\n\n{post_text}"


def call_llm(proxy_url: str, model: str, context: str, question: str, *, timeout: float = 180.0) -> dict:
    headers = {
        "Content-Type": "application/json",
        "X-Caller-Clearance": "UNCLASS",
        "X-Classification": "UNCLASS",
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Answer briefly using only the information in the user message."},
            {"role": "user", "content": f"{context}\n\nQuestion: {question}"},
        ],
        "temperature": 0.0,
        "max_tokens": 128,
    }
    start = time.monotonic()
    with httpx.Client(timeout=timeout) as client:
        resp = client.post(f"{proxy_url}/v1/chat/completions", json=payload, headers=headers)
    resp.raise_for_status()
    elapsed = time.monotonic() - start
    body = resp.json()
    content = body.get("choices", [{}])[0].get("message", {}).get("content", "")
    return {"content": content, "elapsed_s": elapsed, "usage": body.get("usage", {})}


def evaluate_answer(answer: str, tc: dict) -> dict:
    """Score the answer: exact serial, hours, risk score, and factor retrieval."""
    a = answer.lower()
    return {
        "serial_found": "usmc-zz-47392" in a,
        "hours_found": str(tc["hours"]) in a,
        "risk_found": str(tc["risk"]) in a,
        "unit_found": tc["unit"].lower() in a,
    }


def run(args) -> dict:
    results = []
    for depth in args.depths:
        depth = int(depth)
        for tc in TEST_CASES:
            needle = NEEDLE_TEMPLATE.format(**tc)
            for position in args.positions:
                context = build_context(needle, depth, position=position)
                question = (
                    f"What is the operating hours, risk score, and unit for the JLTV with serial USMC-ZZ-47392?"
                )
                try:
                    result = call_llm(args.proxy, args.model, context, question, timeout=args.timeout)
                    scored = evaluate_answer(result["content"], tc)
                    results.append({
                        "case_id": tc["id"],
                        "depth_tokens": depth,
                        "position": position,
                        "context_chars": len(context),
                        "elapsed_s": round(result["elapsed_s"], 2),
                        "answer_excerpt": result["content"][:160],
                        "scored": scored,
                        "retrieval_count": sum(scored.values()),
                    })
                    print(
                        f"    depth={depth}  pos={position}  case={tc['id']}  "
                        f"elapsed={result['elapsed_s']:.1f}s  score={sum(scored.values())}/4"
                    )
                except Exception as exc:  # noqa: BLE001
                    results.append({
                        "case_id": tc["id"],
                        "depth_tokens": depth,
                        "position": position,
                        "error": str(exc),
                    })
                    print(f"    depth={depth}  pos={position}  case={tc['id']}  ERROR: {exc}")

    # Aggregate
    by_depth: dict = {}
    for r in results:
        if "error" in r:
            continue
        d = r["depth_tokens"]
        by_depth.setdefault(d, []).append(r["retrieval_count"])

    summary = {}
    for d, scores in sorted(by_depth.items()):
        avg = sum(scores) / len(scores)
        summary[str(d)] = {
            "avg_retrieval_count_out_of_4": round(avg, 2),
            "recall_rate": round(avg / 4, 3),
            "samples": len(scores),
        }

    report = {
        "model": args.model,
        "proxy": args.proxy,
        "depths": args.depths,
        "positions": args.positions,
        "results": results,
        "summary_by_depth": summary,
    }
    out = Path(__file__).parent / "runs" / "needle_in_haystack"
    out.mkdir(parents=True, exist_ok=True)
    out_path = out / f"report_{int(time.time())}.json"
    out_path.write_text(json.dumps(report, indent=2))
    print(f"\nReport: {out_path}")
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proxy", default="http://127.0.0.1:8095")
    parser.add_argument("--model", default="llama4-maverick")  # proxy alias for gemma4
    parser.add_argument("--depths", nargs="+", default=["10000", "50000", "128000", "256000", "500000"])
    parser.add_argument("--positions", nargs="+", default=["middle", "start", "end"])
    parser.add_argument("--timeout", type=float, default=180.0)
    args = parser.parse_args(argv)
    run(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
