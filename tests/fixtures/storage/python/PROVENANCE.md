# Provenance

Six synthetic files copied unmodified from the Go edition's test data:

- Source: `llm-cli-go` at `b064decc66cad7d9656488bdf7749650b52cf309`, `internal/storage/testdata/python/*.json`.
- Originally generated there by the Python 0.3.0 serializers (`llm-cli-python` at `0a6d045c022b850371a1c51a1df30f11d9d4c60e`) with `scripts/python_storage_parity.py generate`, from synthetic data only.
- They contain no user data. Byte-exactness matters (LF endings, trailing newline, `active.json` on one line): `.gitattributes` is `* text=auto eol=lf` and the tests compare bytes.
