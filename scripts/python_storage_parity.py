"""Development helper for `npm run test:parity`: drives the read-only Python
reference serializers/validators (storage, settings, usage) on synthetic data.

  python3 -B -I scripts/python_storage_parity.py generate <python-src> <out-dir>
      Write synthetic files with the Python writers (HistoryStore.save,
      SettingsStore.save, save_active) into <out-dir>.
  python3 -B -I scripts/python_storage_parity.py check <python-src> <in-dir>
      Load every conversation*/settings*/active* file in <in-dir> with the
      Python readers, save it again with the Python writers into a temporary
      directory, and print {file name: rewritten text} as ASCII-safe JSON.

Only neurobrau_cli.storage, .settings, .usage (plus the tiny conversation and
providers.base data modules they import) are imported; the CLI and the
providers are never initialized. Nothing is written into the reference
repository (bytecode writing is disabled) and no network is used.
"""

import json
import shutil
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path

sys.dont_write_bytecode = True


def import_reference(src: str):
    sys.path.insert(0, src)
    from neurobrau_cli import settings, storage  # noqa: PLC0415
    from neurobrau_cli.conversation import Message  # noqa: PLC0415
    from neurobrau_cli.providers.base import TokenUsage  # noqa: PLC0415
    from neurobrau_cli.usage import UsageRecord  # noqa: PLC0415

    return storage, settings, Message, TokenUsage, UsageRecord


def at(text: str) -> datetime:
    return datetime.fromisoformat(text).astimezone(UTC)


def generate(src: str, out: Path) -> None:
    storage, settings, Message, TokenUsage, UsageRecord = import_reference(src)
    big = 2**70 + 5
    conversations = [
        ("py_big_counts", storage.StoredConversation(
            id="0a0a0a0a-0b0b-4c0c-8d0d-0e0e0e0e0e0e",
            created_at=at("2026-10-21T14:00:00.123456+02:00"),
            updated_at=at("2026-01-01T00:30:00+01:00"),
            provider="ollama", model="hf.co/org/model:Q4_K_M",
            messages=(
                Message("user", 'ctrl \x01 \x1f \b \f del\x7f q" b\\ \r\n\t     \U0001F600 é'),
                Message("assistant", ""),
            ),
            requests=(
                UsageRecord(at("2026-10-21T12:00:00.000+00:00"), "ollama", "m",
                            TokenUsage(9007199254740993, 9223372036854775807, big, 0, None, 0),
                            "", "incomplete"),
                UsageRecord(at("1969-12-31T23:59:59.999+00:00"), "", "", TokenUsage()),
            ),
        )),
        ("py_unknown_provider", storage.StoredConversation(
            id="ffffffff-ffff-1fff-ffff-ffffffffffff",
            created_at=at("0001-01-01T00:00:00.000+00:00"),
            updated_at=at("9999-12-31T23:59:59.999+00:00"),
            provider="futureai", model="vendor/model:tag",
        )),
    ]
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        store = storage.HistoryStore(Path(tmp) / "neurobrau" / "conversations")
        for name, conversation in conversations:
            store.save(conversation)
            shutil.copyfile(store.path_for(conversation.id), out / f"conversation_{name}.json")
        store.save_active("ollama", 'mödel "q" \\ 日本 \U0001F600\n')
        shutil.copyfile(store.active_path, out / "active_py.json")

        prefs = settings.UserSettings(answer_style="detailed")
        for provider, model, kwargs in (
            ("\U0001F600", "z", {"reasoning": "low"}),
            ("￮", "bmp-high", {"max_output_tokens": 1, "max_output_tokens_set": True}),
            ("__proto__", "__proto__", {"max_output_tokens": None, "max_output_tokens_set": True}),
            ("__proto__", "constructor", {"reasoning": "default"}),
            ("ollama", "10", {"max_output_tokens": big, "max_output_tokens_set": True}),
            ("ollama", "9", {"reasoning": "off"}),
            ("ollama", "1", {"reasoning": "high"}),
            ("ollama", "a/b:c", {"max_output_tokens": 600, "max_output_tokens_set": True}),
            ("ollama", "Z", {"reasoning": "upper"}),
            ("ollama", "é", {"reasoning": "x"}),
            ("openai", "gpt-6-luna", {"reasoning": "on", "max_output_tokens": 9007199254740993,
                                      "max_output_tokens_set": True}),
        ):
            prefs = prefs.with_model(provider, model, **kwargs)
        settings_path = Path(tmp) / "config" / "neurobrau" / "settings.json"
        warning = settings.SettingsStore(settings_path).save(prefs)
        if warning:
            raise SystemExit(warning)
        shutil.copyfile(settings_path, out / "settings_py.json")


def check(src: str, directory: Path) -> None:
    storage, settings, *_ = import_reference(src)
    rewritten: dict[str, str] = {}
    problems: dict[str, str] = {}
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        store = storage.HistoryStore(root / "neurobrau" / "conversations")
        for path in sorted(directory.iterdir()):
            name = path.name
            try:
                if name.startswith("conversation"):
                    conversation = store.load(path)
                    store.save(conversation)
                    text = store.path_for(conversation.id).read_text(encoding="utf-8")
                elif name.startswith("settings"):
                    target = root / "config" / "neurobrau" / "settings.json"
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(path, target)
                    settings_store = settings.SettingsStore(target)
                    loaded, warnings = settings_store.load()
                    if warnings or not settings_store.writable:
                        raise ValueError(f"python warned: {warnings}")
                    target.unlink()
                    if settings_store.save(loaded):
                        raise ValueError("python could not save")
                    text = target.read_text(encoding="utf-8")
                elif name.startswith("active"):
                    store.ensure_directory()
                    shutil.copyfile(path, store.active_path)
                    active, warning = store.load_active()
                    if active is None:
                        raise ValueError(warning or "no active selection")
                    store.save_active(*active)
                    text = store.active_path.read_text(encoding="utf-8")
                else:
                    continue
            except (storage.HistoryError, ValueError) as error:
                problems[name] = str(error)
                continue
            rewritten[name] = text
    json.dump({"rewritten": rewritten, "problems": problems}, sys.stdout, ensure_ascii=True)


def main() -> None:
    if len(sys.argv) != 4 or sys.argv[1] not in ("generate", "check"):
        raise SystemExit(__doc__)
    command, src, directory = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    (generate if command == "generate" else check)(src, directory)


if __name__ == "__main__":
    main()
