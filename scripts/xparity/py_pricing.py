"""Oracle for `npm run test:cross-parity`: the REAL pinned Python pricing functions.

  python3 -B -I scripts/xparity/py_pricing.py <python-src> <cases.json>

Input: {"cases": [{"name", "records": [...]}], "money": ["0.0099995", ...]}; counts
are decimal strings. Output lists (not objects) so duplicates and omissions are
detectable. Real `neurobrau_cli.pricing` and `UsageRecord`/`TokenUsage` are used;
the only adjustment is a raised `decimal` context precision derived from the digits
of the inputs, inside an isolated localcontext, so Python's default 28 digits cannot
round the reference's products of huge counts. Nothing is written.
"""

import json
import re
import sys
from datetime import UTC, datetime
from decimal import Decimal, localcontext
from pathlib import Path

sys.dont_write_bytecode = True

COUNTS = ("input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "cache_write_tokens", "reasoning_tokens")


def cost_json(cost):  # noqa: ANN001, ANN202
    if cost is None:
        return None
    amount = None if cost.amount is None else format(cost.amount, "f")
    return {"status": cost.status, "amount": amount, "notes": list(cost.notes)}


def main(src: str, cases_path: Path) -> None:
    sys.path.insert(0, src)
    from neurobrau_cli import pricing  # noqa: PLC0415
    from neurobrau_cli.providers.base import TokenUsage  # noqa: PLC0415
    from neurobrau_cli.usage import UsageRecord  # noqa: PLC0415

    raw = cases_path.read_text(encoding="utf-8")
    data = json.loads(raw)
    digits = max((len(t) for t in re.findall(r"\d+", raw)), default=1)
    at = datetime(2026, 10, 22, tzinfo=UTC)

    def record(item: dict) -> UsageRecord:
        counts = {name: (None if item["usage"].get(name) is None else int(item["usage"][name])) for name in COUNTS}
        return UsageRecord(at, item["provider"], item["model"], TokenUsage(**counts), item.get("tier"), item.get("status", "completed"))

    cases, money = [], []
    with localcontext() as context:
        context.prec = 2 * digits + 60
        for case in data["cases"]:
            records = [record(item) for item in case["records"]]
            total = pricing.total_cost(records)
            cases.append({
                "name": case["name"],
                "estimates": [cost_json(pricing.estimate(r)) for r in records],
                "total": cost_json(total),
                "short": pricing.format_cost_short(total),
                "describe": pricing.describe_cost(total),
            })
        for text in data["money"]:
            money.append({"amount": text, "text": pricing.format_money(Decimal(text))})
    json.dump({"version": pricing.PRICING_VERSION, "sources": list(pricing.PRICING_SOURCES), "cases": cases, "money": money}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main(sys.argv[1], Path(sys.argv[2]))
