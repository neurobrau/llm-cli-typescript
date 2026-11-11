"""Development helper: runs the REAL pinned Python pricing functions over a case list.

  python3 -B -I scripts/python_pricing_parity.py <python-src> <cases.json>

<cases.json> holds {"cases": [{"name", "records": [...]}], "money": ["0.0099995", ...]}.
Counts are decimal STRINGS (or null) so integers of any size survive JSON. Each
record becomes a real `neurobrau_cli.usage.UsageRecord` / `TokenUsage`; the real
`pricing.estimate`, `pricing.total_cost`, `format_cost_short`, `describe_cost`
and `format_money` produce the results, printed as JSON on stdout. Nothing is
written (no bytecode), and no formula is reimplemented here.

Decimal's default precision (28 digits) would round the reference's products
for very large counts. Only the context precision is raised, derived from the
digits of the inputs, inside an isolated `decimal.localcontext()`; no reference
file or function is modified.
"""

import json
import sys
from datetime import UTC, datetime
from decimal import Decimal, localcontext
from pathlib import Path

sys.dont_write_bytecode = True

COUNT_KEYS = (
    ("input_tokens", "input_tokens"),
    ("output_tokens", "output_tokens"),
    ("total_tokens", "total_tokens"),
    ("cached_input_tokens", "cached_input_tokens"),
    ("cache_write_tokens", "cache_write_tokens"),
    ("reasoning_tokens", "reasoning_tokens"),
)


def amount_text(amount: Decimal | None) -> str | None:
    return None if amount is None else format(amount, "f")


def cost_json(cost):  # noqa: ANN001, ANN202
    if cost is None:
        return None
    return {"status": cost.status, "amount": amount_text(cost.amount), "notes": list(cost.notes)}


def main(src: str, cases_path: Path) -> None:
    sys.path.insert(0, src)
    from neurobrau_cli import pricing  # noqa: PLC0415
    from neurobrau_cli.providers.base import TokenUsage  # noqa: PLC0415
    from neurobrau_cli.usage import UsageRecord  # noqa: PLC0415

    raw = cases_path.read_text(encoding="utf-8")
    data = json.loads(raw)
    digits = max((len(t) for t in __import__("re").findall(r"\d+", raw)), default=1)
    at = datetime(2026, 10, 22, tzinfo=UTC)

    def to_record(item: dict) -> UsageRecord:
        counts = {name: (None if item["usage"].get(key) is None else int(item["usage"][key])) for name, key in COUNT_KEYS}
        return UsageRecord(at, item["provider"], item["model"], TokenUsage(**counts), item.get("tier"), item.get("status", "completed"))

    result = {"version": pricing.PRICING_VERSION, "sources": list(pricing.PRICING_SOURCES), "cases": {}, "money": {}}
    with localcontext() as context:
        context.prec = 2 * digits + 60
        for case in data["cases"]:
            records = [to_record(item) for item in case["records"]]
            total = pricing.total_cost(records)
            result["cases"][case["name"]] = {
                "estimates": [cost_json(pricing.estimate(record)) for record in records],
                "total": cost_json(total),
                "short": pricing.format_cost_short(total),
                "describe": pricing.describe_cost(total),
            }
        for text in data["money"]:
            result["money"][text] = pricing.format_money(Decimal(text))
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main(sys.argv[1], Path(sys.argv[2]))
