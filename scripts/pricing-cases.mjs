// The shared deterministic case list for the pricing parity check. Counts are
// decimal strings (or null = not reported) so that any size survives JSON.
const LUNA = "gpt-6-luna";
const rec = (usage, { provider = "openai", model = LUNA, tier = "default", status = "completed" } = {}) => ({
  provider,
  model,
  ...(tier === undefined ? {} : { tier }),
  status,
  usage,
});
const full = (i, o, c = "0", w = "0", r = "0") => ({
  input_tokens: i,
  output_tokens: o,
  total_tokens: String(BigInt(i) + BigInt(o)),
  cached_input_tokens: c,
  cache_write_tokens: w,
  reasoning_tokens: r,
});
const bare = (i, o) => ({ input_tokens: i, output_tokens: o });

const cases = [];
const add = (name, ...records) => cases.push({ name, records });

add("standard example", rec(full("15000", "2000", "4000", "1000")));
add("reasoning not added", rec(full("1000", "2000", "0", "0", "1500")));
add("no reasoning", rec(full("1000", "2000")));
add("total inconsistent", rec({ ...full("1000", "2000"), total_tokens: "7" }));
add("total absent", rec({ input_tokens: "1000", output_tokens: "2000", cached_input_tokens: "0", cache_write_tokens: "0" }));
add("threshold exact", rec(full("272000", "1000")));
add("threshold above", rec(full("272001", "1000")));
add("threshold cache heavy", rec(full("272000", "1000", "271000", "500")));
add("threshold above cache heavy", rec(full("272001", "1000", "271000", "500")));
add("two short requests", rec(full("200000", "1000")), rec(full("200000", "1000")));
for (const tier of ["default", "flex", "batch", "fast", "priority", "auto", "ultrafast", "", "DEFAULT"]) {
  add(`luna tier ${JSON.stringify(tier)}`, rec(full("100000", "10000"), { tier }));
}
add("luna tier absent", rec(full("1000", "1000"), { tier: undefined }));
for (const tier of ["default", "flex", "priority", "auto", ""]) {
  add(`gpt-5.1 tier ${JSON.stringify(tier)}`, rec(full("10000", "500"), { model: "gpt-5.1", tier }));
}
add("gpt-5.1 absent tier", rec(full("10000", "500"), { model: "gpt-5.1", tier: undefined }));
add("missing cache breakdown", rec(bare("10000", "1000")));
add("missing writes only", rec({ ...bare("10000", "1000"), cached_input_tokens: "2000" }));
add("missing cached only", rec({ ...bare("10000", "1000"), cache_write_tokens: "300" }));
add("reported zero cache", rec({ ...bare("10000", "1000"), cached_input_tokens: "0", cache_write_tokens: "0" }));
add("gpt-5.1 missing writes", rec({ ...bare("10000", "1000"), cached_input_tokens: "10" }, { model: "gpt-5.1" }));
add("gpt-5.1 writes as input", rec(full("10000", "0", "2000", "3000"), { model: "gpt-5.1" }));
add("long context missing writes", rec({ ...bare("272001", "10"), cached_input_tokens: "1" }));
add("missing input", rec({ output_tokens: "5" }));
add("missing output", rec({ input_tokens: "10" }));
add("both missing", rec({}));
add("inconsistent", rec({ ...bare("10", "1"), cached_input_tokens: "8", cache_write_tokens: "5" }));
add("exactly consistent", rec({ ...bare("13", "1"), cached_input_tokens: "8", cache_write_tokens: "5" }));
add("snapshot suffix", rec(full("1000", "1000"), { model: "gpt-6-luna-2026-09-01" }));
add("snapshot gpt-5.1", rec(full("1000", "1000"), { model: "gpt-5.1-2025-11-13" }));
for (const model of ["gpt-4o", "my-fine-tune", "GPT-6-LUNA", "gpt-6-luna-2026-9-01", "gpt-6-luna-preview", "gpt-6-luna-2026-09-01-2026-09-01", "gpt-6", "constructor", "__proto__", ""]) {
  add(`model ${JSON.stringify(model)}`, rec(full("1", "1"), { model }));
}
add("ollama local", rec(full("10", "10"), { provider: "ollama", model: "qwen3.5:4b", tier: undefined }));
add("ollama local no counts", rec({}, { provider: "ollama", model: "llama3", tier: undefined }));
add("ollama cloud", rec(full("10", "10"), { provider: "ollama", model: "glm-4.7:cloud", tier: undefined }));
add("ollama cloud suffix", rec(full("10", "10"), { provider: "ollama", model: "gemma4:31b-cloud", tier: undefined }));
add("ollama cloud in name", rec(full("10", "10"), { provider: "ollama", model: "cloud:7b", tier: undefined }));
add("ollama not a cloud tag", rec(full("10", "10"), { provider: "ollama", model: "x:mycloud", tier: undefined }));
add("unknown provider", rec(full("10", "10"), { provider: "acme", model: LUNA }));
add("empty conversation");
add("all local", rec(full("1", "1"), { provider: "ollama", model: "a", tier: undefined }), rec({}, { provider: "ollama", model: "b", tier: undefined }));
add("mixed exact", rec(full("1000", "1000")), rec(full("2000", "1000")));
add("mixed qualified", rec(full("1000", "1000")), rec(full("1000", "1000"), { tier: undefined }));
add("partial unknown model", rec(full("1000", "1000")), rec(full("1", "1"), { model: "unknown-model" }));
add("partial zero", rec({}, { provider: "ollama", model: "a", tier: undefined }), rec(full("1", "1"), { model: "x" }));
add("local plus openai", rec(full("1000", "1000")), rec({}, { provider: "ollama", model: "a", tier: undefined }));
add("all unavailable", rec(full("1", "1"), { model: "x" }), rec(full("1", "1"), { model: "x" }), rec({ input_tokens: "1" }));
add("note dedup", rec(bare("10", "1")), rec(bare("20", "2")), rec(full("10", "1"), { tier: undefined }), rec({ input_tokens: "1" }));
add("incomplete counted", rec(full("1000", "10"), { status: "incomplete" }), rec(full("1000", "10")));
add("zero tokens", rec(full("0", "0")));
add("huge safe+", rec(full("9007199254740993", "9007199254740993")));
add("signed 64 limit", rec(full("9223372036854775807", "9223372036854775807", "9223372036854775806", "1")));
add("beyond 64 bit", rec(full(String(2n ** 70n + 5n), String(2n ** 70n + 5n), String(2n ** 69n), "7")));
add("huge cache sum overflow", rec({ ...bare("10", "1"), cached_input_tokens: String(2n ** 70n), cache_write_tokens: String(2n ** 70n) }));
add("huge sum", rec(full(String(2n ** 70n + 5n), "1")), rec(full(String(2n ** 70n + 7n), "3")), rec(full("1", String(2n ** 80n)), { tier: "fast" }));
add("tiny", rec(full("1", "0"), { tier: "flex" }));
add("tiny two requests", rec(full("1", "0"), { tier: "flex" }), rec(full("3", "0"), { tier: "flex" }));
add("half cent edge", rec(full("99995", "0"), { model: "gpt-6-luna" }));
add("cent boundary", rec(full("0", "20000"), { tier: "default" }));
add("many requests", ...Array.from({ length: 25 }, (_, index) => rec(full(String(1000 + index * 37), String(index * 11), String(index), "1"))));

// Display fixtures: exact decimal strings.
const money = [
  "0", "0.0000004", "0.0000005", "0.0000015", "0.000165", "0.0021654", "0.0021655", "0.0099995", "0.0099994",
  "0.00999949", "0.00999999", "0.01", "0.0100005", "0.01005", "0.01004999", "0.99995", "0.99994", "1", "12.345678", "12.34565",
  "12.34555", "999.99995", "99999.99995", "100000000.5", "123456789012345678901234567890.12345",
];

export const CASES = Object.freeze(cases);
export const MONEY = Object.freeze(money);
