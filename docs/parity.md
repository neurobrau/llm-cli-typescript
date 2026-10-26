# Parity with the Python and Go editions

## Bootstrap limitations

`0.1.0-dev` implements only `-h`/`--help` and `--version`. Not implemented: providers, prompt and chat modes, history and settings storage, streaming, pricing, model discovery, terminal UI. Python/Go options such as `--provider`, `--model`, `--stream`, and `--no-history` are rejected as unsupported (exit 2), not ignored. Exit codes 8 and 130 from the reference specification are not yet produced; 141 (broken pipe) is.

## References

- Python (primary behavior reference): `0a6d045c022b850371a1c51a1df30f11d9d4c60e`
- Go: `b064decc66cad7d9656488bdf7749650b52cf309`

Both are read-only. The Go version constant (`0.4.0-dev`) and the Python version are independent of this edition's `0.1.0-dev`.

## Proposed future decisions (not implemented, not yet accepted by the owner)

- Python's language-neutral specification is the primary contract; each deviation is recorded individually.
- Adopt Go's responsive background model discovery and safe terminal restoration, without copying goroutines or Python threads literally.
- Plan Go-style handling of incomplete non-streaming answers: do not commit the messages, but account for reported usage.
- One-shot saved settings is a proposed exception to Python: use flags and built-in defaults without reading settings, as Go does.
