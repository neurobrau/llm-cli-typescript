# Estimated API costs

Version `0.4.0` (Task 010 added the estimates; the previous milestone was `0.3.0`, TUI). Costs are **estimates**, never billed amounts, and are computed from the stored usage records; nothing about cost is persisted (no cost or catalog field in `settings.json`, `active.json` or conversation files) and nothing is fetched at run time (no price refresh, billing or account access).

## The catalog is a dated reference snapshot

`src/pricing/catalog.ts` copies the pinned reference catalog **dated 2026-10-22** (Python `pricing.py` at `0a6d045c022b850371a1c51a1df30f11d9d4c60e`, Go `internal/pricing/pricing.go` at `b064decc66cad7d9656488bdf7749650b52cf309`). The date is the reference's own; it is not a statement that the rates are current. Provenance URLs (also `PRICING_SOURCES`):

- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/api/docs/models/gpt-5.1
- https://developers.openai.com/api/docs/guides/prompt-caching

USD per 1,000,000 tokens:

| Model / range | Input | Cached input | Cache writes | Output |
| --- | --- | --- | --- | --- |
| `gpt-6-luna`, request input ≤ 272000 | 0.10 | 0.01 | 0.125 | 0.50 |
| `gpt-6-luna`, request input > 272000 | 0.20 | 0.02 | 0.25 | 0.75 |
| `gpt-5.1` | 1.25 | 0.125 | as input | 10.00 |

Tier factors: `gpt-6-luna` default 1, `flex`/`batch` 0.5, `fast`/`priority` 2; `gpt-5.1` default only. Anything else (other models, case variants, prefixes, fine-tunes, other tiers, an explicitly empty tier) is **unavailable**. The only fallback is one anchored `-YYYY-MM-DD` suffix to the exact base model. Pricing never sets or sends a tier.

### What was retrieved on 2026-11-10 (current-documentation check)

The four URLs above were fetched by a web-fetch helper on 2026-11-10 (all returned content; no page shows an "updated" date; the prompt-caching page was truncated by the fetcher, so only its verbatim part is relied on):

- `gpt-6-luna` standard short/long input, cached input, 30m cache write and output rates, the 272K threshold, the 2x/1.5x long-context rule, Flex/Batch 50% and Fast 2x **match** the catalog.
- Differences, **not** implemented (out of scope): the pricing page now also lists a 12h cache-write rate ($0.25 short / $0.50 long, `prompt_cache_options.ttl`); `gpt-5.1` is marked deprecated and the pricing page lists Batch/Flex/Fast rates for it that the reference catalog does not (the catalog supports only its default tier, so those tiers stay unavailable); regional/data-residency endpoints carry a 10% uplift (not modeled; the app does not use them). This is not authorization to change requests, the SDK or caching controls.

## Arithmetic

`src/pricing/` is pure (no fs, process, network, SDK, provider or terminal imports) and uses `bigint` only. Rates are exact thousandths (`parseRate` accepts only checked decimals with ≤3 places), tier factors are halves, and an amount is an integer number of 1/2,000,000,000 USD (`Usd.units`), so every estimate and every sum is exact and unrounded. Rounding happens only in `formatMoney`: HALF UP, six decimals below one cent and four otherwise (chosen from the exact amount before rounding), `$0` only for an exact zero, so a tiny positive amount shows `$0.000000`. There is no `Number(bigint)`, float rate or epsilon.

Per request, from that record's own provider/model/tier and its **reported** counts: `((I−C−W)·in + C·cached + W·write + O·out) · factor / 1,000,000`. Cached and write counts are subsets of the input; writes replace ordinary input (no surcharge); reasoning is already in output; `totalTokens` is never an operand. The long-context rate applies to the whole request when that request's reported input is strictly above 272000, before subtracting cache parts. Missing information: tier absent or `auto` → standard assumed (qualified); cached count absent → zero (qualified); write count absent → zero (qualified only for a model/range with a special write rate); reported zero is known and silent; absent input or output → unavailable; `C+W > I` → unavailable (never a negative amount). Assumptions never fill the stored usage or the displayed counts.

Local Ollama is `free_local` (zero **API** cost, not electricity or hardware); Ollama cloud tags (`cloud` or a tag ending in `-cloud`) and unknown providers are unavailable, never free.

Aggregation sums unrounded amounts: no records → no estimate (`-`); all local → `free_local`; no known amount → unavailable; known plus unavailable → `partial` ("at least", known zero stays an amount); else `qualified` if any record is, otherwise `estimated`. Notes are deduplicated in first-seen order.

## Display

- `/usage` (plain and fullscreen, one shared function) keeps the TS details (completed/incomplete header, every count with `not reported` and reported-subtotal annotations, latest completed request input) and ends with the cost line: `Estimated cost: [approximately |at least ]$x (ESTIMATED, not a billed amount; pricing 2026-10-22[; notes])`, `Estimated cost: unavailable (notes)`, `API cost: $0 (local Ollama inference)` or, for an empty conversation, `Token usage: no API requests in this conversation yet.` followed by `Estimated cost: - (no requests yet)`.
- Notes can contain saved model/provider/tier names, so control characters in them are shown as `\xNN` escapes (identical text for ordinary names). This is a deliberate difference from the references for hostile input only; the fullscreen screen additionally neutralizes everything it draws.
- The `COST (EST.)` panel row shows the short form (`-`, `$0 (local)`, `$0.002165`, `~$…`, `>=$…`, `unavailable`), computed when the panel statistics are refreshed (restore, accepted completed/incomplete request, switch, reset, cleanup), never per frame, delta or timer tick. The status bar is unchanged.
- One-shot `--usage` and the immediate per-response `--usage` line are unchanged and show no cost.

## Verification

- Pure/unit and integration tests: `tests/pricing.test.ts`, `tests/pricing-usage.test.ts`, `tests/pricing-parity-script.test.ts`.
- **Executed** Python parity: `npm run test:pricing-parity` imports the real `neurobrau_cli.pricing` and `UsageRecord`/`TokenUsage` (Python `-B -I`, isolated temp HOME, nothing written to the reference) over `scripts/pricing-cases.mjs` (78 cases / 117 records / 25 money fixtures) and compares per-record status, exact amount and notes, aggregate status/amount/notes, and short/long/money text. The harness only raises `decimal` context precision (derived from the input digits, inside `localcontext()`) so Python's default 28 digits cannot manufacture a false mismatch for huge counts; no reference code is altered. A negative control corrupts the reference result and must be detected. Exit 0 pass, 1 failure, 3 BLOCKED (interpreter, reference or its dependencies unavailable: never a pass).
- The real Go pricing functions are executed by the Task 011 gate (`npm run test:cross-parity`, see `docs/parity.md`) against the same corpus. Values above 64 bits are TypeScript/Python-only: Go reads signed 64-bit integers, so those cases are classified out of the Go domain (never rounded).
- Known, deliberate differences from Python for unusual input: `\d` in the snapshot suffix is ASCII-only and `$` does not match before a trailing newline in TypeScript (Python's would).
