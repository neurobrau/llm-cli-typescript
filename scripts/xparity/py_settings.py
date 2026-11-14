"""Oracle for `npm run test:cross-parity`: the REAL Python settings resolver.

  python3 -B -I scripts/xparity/py_settings.py <python-src> <cases.json>

Each case supplies a model's reasoning support (or a lookup error), an output
limit, saved preferences, command-line overrides and strictness; the real
`neurobrau_cli.preferences.resolve_model_settings` result is printed as JSON.
A fake provider supplies only the capabilities; nothing else is imported from
the providers. Nothing is written (no bytecode, no files).
"""

import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True


def main(src: str, cases_path: Path) -> None:
    sys.path.insert(0, src)
    from neurobrau_cli import preferences  # noqa: PLC0415
    from neurobrau_cli.providers.base import ErrorKind, ProviderError, ReasoningSupport  # noqa: PLC0415
    from neurobrau_cli.settings import ModelPreferences, SettingsError  # noqa: PLC0415

    class FakeProvider:
        def __init__(self, case: dict) -> None:
            self.case = case

        def reasoning_support(self, model: str) -> ReasoningSupport:
            if self.case["support_error"]:
                raise ProviderError(self.case["support_error"], ErrorKind.CONNECTION)
            s = self.case["support"]
            return ReasoningSupport(tuple(s["values"]), s["known"], s["default"] or None, s["allows_default"])

        def max_output_limit(self, model: str) -> int | None:
            return self.case["limit"]

    result: list[dict] = []
    seen: set[str] = set()
    for case in json.loads(cases_path.read_text(encoding="utf-8")):
        if case["id"] in seen:
            raise SystemExit(f"duplicate case id {case['id']!r}")
        seen.add(case["id"])
        p = case["prefs"]
        prefs = ModelPreferences(reasoning=p["reasoning"], max_output_tokens=p["max"], max_output_tokens_set=p["max_set"])
        o = case["overrides"]
        overrides = preferences.Overrides(reasoning=o["reasoning"], max_output_tokens=o["max"])
        provider = FakeProvider(case)
        try:
            resolved, notices = preferences.resolve_model_settings(provider, "m", prefs, overrides, case["strict"])
        except SettingsError as error:
            result.append({"id": case["id"], "error": str(error)})
            continue
        result.append({
            "id": case["id"],
            "effort": resolved.reasoning or "",
            "explicit": resolved.reasoning_explicit,
            "effective": resolved.reasoning or "",
            "max": resolved.max_output_tokens or 0,
            "notices": notices,
        })
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main(sys.argv[1], Path(sys.argv[2]))
