"""Oracle for `npm run test:cross-parity`: write conversations with the REAL Python writer.

  python3 -B -I scripts/xparity/py_storage_write.py <python-src> <spec.json> <out-dir>

<spec.json> is a list of {"file", "id", "created_at", "updated_at", "provider", "model",
"messages", "requests"} with counts as decimal strings. Each is saved with
`HistoryStore.save` inside a private temporary directory and copied to <out-dir>.
"""

import json
import shutil
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path

sys.dont_write_bytecode = True

COUNTS = ("input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "cache_write_tokens", "reasoning_tokens")


def moment(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(UTC)


def main(src: str, spec_path: Path, out: Path) -> None:
    sys.path.insert(0, src)
    from neurobrau_cli import storage  # noqa: PLC0415
    from neurobrau_cli.conversation import Message  # noqa: PLC0415
    from neurobrau_cli.providers.base import TokenUsage  # noqa: PLC0415
    from neurobrau_cli.usage import UsageRecord  # noqa: PLC0415

    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        store = storage.HistoryStore(Path(tmp) / "neurobrau" / "conversations")
        for item in json.loads(spec_path.read_text(encoding="utf-8")):
            requests = tuple(
                UsageRecord(
                    moment(r["at"]), r["provider"], r["model"],
                    TokenUsage(**{name: (None if r["usage"].get(name) is None else int(r["usage"][name])) for name in COUNTS}),
                    r.get("tier"), r.get("status", "completed"),
                )
                for r in item["requests"]
            )
            conversation = storage.StoredConversation(
                id=item["id"], created_at=moment(item["created_at"]), updated_at=moment(item["updated_at"]),
                provider=item.get("provider"), model=item.get("model"),
                messages=tuple(Message(m["role"], m["content"]) for m in item["messages"]), requests=requests,
            )
            store.save(conversation)
            shutil.copyfile(store.path_for(conversation.id), out / item["file"])


if __name__ == "__main__":
    main(sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]))
