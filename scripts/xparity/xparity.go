// Development adapter for `npm run test:cross-parity`. It is copied into a
// private temporary copy of the pinned Go reference module (as cmd/xparity)
// so it can import the reference's internal packages; it is never placed in
// the reference worktree. It runs the REAL Go storage codecs, settings
// resolver and pricing functions and prints JSON on stdout.
//
//	xparity storage-check <dir>    load each conversation*/settings*/active* file, write it back
//	xparity storage-generate <dir> write Go-produced fixture files
//	xparity storage-write <spec.json> <dir> write the conversations of a spec with storage.EncodeConversation
//	xparity settings <cases.json>  chat.ResolveSettings / ResolveSwitchedSettings per case
//	xparity pricing <cases.json>   pricing.Request / Total / Short / Describe / FormatMoney per case
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/neurobrau/llm-cli-go/internal/chat"
	"github.com/neurobrau/llm-cli-go/internal/llm"
	"github.com/neurobrau/llm-cli-go/internal/pricing"
	"github.com/neurobrau/llm-cli-go/internal/storage"
)

func main() {
	if len(os.Args) < 3 || (os.Args[1] == "storage-write" && len(os.Args) != 4) {
		fmt.Fprintln(os.Stderr, "usage: xparity storage-check|storage-generate|settings|pricing <path> | storage-write <spec> <dir>")
		os.Exit(2)
	}
	var out any
	var err error
	switch os.Args[1] {
	case "storage-check":
		out, err = storageCheck(os.Args[2])
	case "storage-write":
		err = storageWrite(os.Args[2], os.Args[3])
		out = map[string]string{"ok": "written"}
	case "storage-generate":
		err = storageGenerate(os.Args[2])
		out = map[string]string{"ok": "generated"}
	case "settings":
		out, err = settingsMatrix(os.Args[2])
	case "pricing":
		out, err = pricingMatrix(os.Args[2])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// ----- storage -----

type checkResult struct {
	Rewritten map[string]string   `json:"rewritten"`
	Problems  map[string]string   `json:"problems"`
	Warnings  map[string][]string `json:"warnings"`
}

func storageCheck(dir string) (any, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	root, err := os.MkdirTemp("", "xparity-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(root)
	res := checkResult{Rewritten: map[string]string{}, Problems: map[string]string{}, Warnings: map[string][]string{}}
	for _, entry := range entries {
		name := entry.Name()
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		switch {
		case strings.HasPrefix(name, "conversation"):
			c, err := storage.DecodeConversation(data)
			if err != nil {
				res.Problems[name] = err.Error()
				continue
			}
			text, err := storage.EncodeConversation(c)
			if err != nil {
				res.Problems[name] = err.Error()
				continue
			}
			res.Rewritten[name] = string(text)
		case strings.HasPrefix(name, "settings"):
			s, warnings, err := storage.DecodeSettings(data)
			if err != nil {
				res.Problems[name] = err.Error()
				continue
			}
			if len(warnings) > 0 {
				res.Warnings[name] = warnings
			}
			text, err := storage.EncodeSettings(s)
			if err != nil {
				res.Problems[name] = err.Error()
				continue
			}
			res.Rewritten[name] = string(text)
		case strings.HasPrefix(name, "active"):
			store := storage.NewHistoryStore(filepath.Join(root, "neurobrau", "conversations"))
			if err := os.MkdirAll(store.Dir(), 0o700); err != nil {
				return nil, err
			}
			if err := os.WriteFile(store.ActivePath(), data, 0o600); err != nil {
				return nil, err
			}
			sel, found, warning := store.LoadActive()
			if !found {
				res.Problems[name] = warning
				continue
			}
			if err := os.Remove(store.ActivePath()); err != nil {
				return nil, err
			}
			if err := store.SaveActive(sel); err != nil {
				res.Problems[name] = err.Error()
				continue
			}
			text, err := os.ReadFile(store.ActivePath())
			if err != nil {
				return nil, err
			}
			res.Rewritten[name] = string(text)
		}
	}
	return res, nil
}

func intp(n int) *int { return &n }

func storageGenerate(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	at := func(s string) time.Time {
		t, err := time.Parse(time.RFC3339Nano, s)
		if err != nil {
			panic(err)
		}
		return t
	}
	conversations := map[string]storage.Conversation{
		"go_usage": {
			ID: "0b0b0b0b-1c1c-4d1d-8e1e-0f0f0f0f0f0f", CreatedAt: at("2026-10-21T14:00:00.123+02:00"), UpdatedAt: at("2026-10-21T12:30:00Z"),
			Provider: "openai", Model: "gpt-6-luna",
			Messages: []llm.Message{{Role: llm.RoleUser, Content: "Grüße \x01 \"q\" \\ 😀\n"}, {Role: llm.RoleAssistant, Content: ""}},
			Requests: []storage.UsageRecord{
				{At: at("2026-10-21T12:00:00Z"), Provider: "openai", Model: "gpt-6-luna", Status: storage.StatusCompleted, ServiceTier: "default",
					Usage: llm.Usage{InputTokens: intp(9007199254740993), OutputTokens: intp(0), TotalTokens: intp(9223372036854775807), CachedInputTokens: intp(0)}},
				{At: at("2026-10-21T12:01:00Z"), Provider: "ollama", Model: "m", Status: storage.StatusIncomplete, EmptyServiceTier: true,
					Usage: llm.Usage{InputTokens: intp(7)}},
				{At: at("1969-12-31T23:59:59.999Z"), Provider: "x", Model: "y", Status: storage.StatusCompleted},
			},
		},
		"go_legacy": {ID: "ffffffff-ffff-1fff-9fff-ffffffffffff", CreatedAt: at("0001-01-01T00:00:00Z"), UpdatedAt: at("9999-12-31T23:59:59.999Z")},
	}
	store := storage.NewHistoryStore(filepath.Join(dir, "neurobrau", "conversations"))
	for name, c := range conversations {
		data, err := storage.EncodeConversation(c)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, "conversation_"+name+".json"), data, 0o600); err != nil {
			return err
		}
	}
	if err := store.SaveActive(storage.Selection{Provider: "ollama", Model: "mödel \"q\" \\ 日本 😀"}); err != nil {
		return err
	}
	active, err := os.ReadFile(store.ActivePath())
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "active_go.json"), active, 0o600); err != nil {
		return err
	}
	s := storage.DefaultSettings()
	s.AnswerStyle = "detailed"
	s = s.WithModel("😀", "z", storage.ModelPreferences{Reasoning: "low"})
	s = s.WithModel("__proto__", "__proto__", storage.ModelPreferences{MaxOutputTokensSet: true})
	s = s.WithModel("__proto__", "constructor", storage.ModelPreferences{Reasoning: storage.ReasoningDefault})
	s = s.WithModel("ollama", "10", storage.ModelPreferences{MaxOutputTokensSet: true, MaxOutputTokens: 9223372036854775807})
	s = s.WithModel("ollama", "9", storage.ModelPreferences{Reasoning: "off", MaxOutputTokensSet: true, MaxOutputTokens: 600})
	s = s.WithModel("ollama", "Z", storage.ModelPreferences{Reasoning: "upper"})
	s = s.WithModel("openai", "gpt-6-luna", storage.ModelPreferences{Reasoning: "on", MaxOutputTokensSet: true, MaxOutputTokens: 9007199254740993})
	data, err := storage.EncodeSettings(s)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "settings_go.json"), data, 0o600)
}

// ----- settings -----

type settingsCase struct {
	ID      string `json:"id"`
	Support struct {
		Values        []string `json:"values"`
		Known         bool     `json:"known"`
		Default       string   `json:"default"`
		AllowsDefault bool     `json:"allows_default"`
	} `json:"support"`
	SupportError string `json:"support_error"`
	Limit        *int   `json:"limit"`
	Prefs        struct {
		Reasoning *string `json:"reasoning"`
		MaxSet    bool    `json:"max_set"`
		Max       *int    `json:"max"`
	} `json:"prefs"`
	Overrides struct {
		Reasoning *string `json:"reasoning"`
		Max       *int    `json:"max"`
	} `json:"overrides"`
	Strict bool `json:"strict"`
}

type fakeProvider struct{ c settingsCase }

func (f fakeProvider) Name() string                                    { return "openai" }
func (f fakeProvider) ListModels(context.Context) ([]llm.Model, error) { return nil, nil }
func (f fakeProvider) DefaultModel(context.Context) (string, error)    { return "m", nil }
func (f fakeProvider) Chat(context.Context, llm.Request) (llm.Response, error) {
	return llm.Response{}, nil
}
func (f fakeProvider) ReasoningSupport(context.Context, string) (llm.ReasoningSupport, error) {
	if f.c.SupportError != "" {
		return llm.ReasoningSupport{}, &llm.Error{Message: f.c.SupportError}
	}
	s := f.c.Support
	return llm.ReasoningSupport{Values: s.Values, Known: s.Known, Default: s.Default, NoModelDefault: !s.AllowsDefault}, nil
}
func (f fakeProvider) MaxOutputLimit(context.Context, string) (int, error) {
	if f.c.Limit == nil {
		return 0, nil
	}
	return *f.c.Limit, nil
}

type settingsResult struct {
	ID        string   `json:"id"`
	Error     *string  `json:"error"`
	Effort    string   `json:"effort"`
	Explicit  bool     `json:"explicit"`
	Effective string   `json:"effective"`
	Max       int      `json:"max"`
	Notices   []string `json:"notices"`
}

func settingsMatrix(path string) (any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cases []settingsCase
	if err := json.Unmarshal(data, &cases); err != nil {
		return nil, err
	}
	out := []settingsResult{}
	seen := map[string]bool{}
	for _, c := range cases {
		saved := storage.DefaultSettings()
		prefs := storage.ModelPreferences{MaxOutputTokensSet: c.Prefs.MaxSet}
		if c.Prefs.Reasoning != nil {
			prefs.Reasoning = *c.Prefs.Reasoning
		}
		if c.Prefs.Max != nil {
			prefs.MaxOutputTokens = *c.Prefs.Max
		}
		saved = saved.WithModel("openai", "m", prefs)
		o := chat.Overrides{}
		if c.Overrides.Reasoning != nil {
			o.Reasoning = *c.Overrides.Reasoning
		}
		if c.Overrides.Max != nil {
			o.MaxOutputTokens = *c.Overrides.Max
		}
		resolve := chat.ResolveSwitchedSettings
		if c.Strict {
			resolve = chat.ResolveSettings
		}
		settings, notices, err := resolve(context.Background(), fakeProvider{c}, "m", saved, o)
		if seen[c.ID] {
			return nil, fmt.Errorf("duplicate case id %q", c.ID)
		}
		seen[c.ID] = true
		if err != nil {
			var se *chat.SettingsError
			if !errors.As(err, &se) {
				return nil, err
			}
			message := err.Error()
			out = append(out, settingsResult{ID: c.ID, Error: &message})
			continue
		}
		support, _ := fakeProvider{c}.ReasoningSupport(context.Background(), "m")
		if notices == nil {
			notices = []string{}
		}
		out = append(out, settingsResult{ID: c.ID, Effort: settings.Reasoning.Effort, Explicit: settings.Reasoning.Explicit,
			Effective: settings.EffectiveReasoning(support), Max: settings.MaxOutputTokens, Notices: notices})
	}
	return out, nil
}

// ----- pricing -----

type pricingRecord struct {
	Provider string             `json:"provider"`
	Model    string             `json:"model"`
	Tier     *string            `json:"tier"`
	Status   string             `json:"status"`
	Usage    map[string]*string `json:"usage"`
}

type pricingCase struct {
	Name    string          `json:"name"`
	Records []pricingRecord `json:"records"`
}

type pricingInput struct {
	Cases []pricingCase `json:"cases"`
	Money []string      `json:"money"`
}

type costOut struct {
	Status string   `json:"status"`
	Num    *string  `json:"num"`
	Den    *string  `json:"den"`
	Notes  []string `json:"notes"`
}

type caseOut struct {
	Name        string    `json:"name"`
	OutOfDomain string    `json:"out_of_domain,omitempty"`
	Estimates   []costOut `json:"estimates"`
	Total       *costOut  `json:"total"`
	Short       string    `json:"short"`
	Describe    string    `json:"describe"`
}

func costJSON(e pricing.Estimate) costOut {
	out := costOut{Status: string(e.Status), Notes: append([]string{}, e.Notes...)}
	if e.Amount != nil {
		n, d := e.Amount.Num().String(), e.Amount.Denom().String()
		out.Num, out.Den = &n, &d
	}
	return out
}

func pricingMatrix(path string) (any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var in pricingInput
	if err := json.Unmarshal(data, &in); err != nil {
		return nil, err
	}
	cases := []caseOut{}
	seen := map[string]bool{}
	maxInt := new(big.Int).SetInt64(1<<63 - 1)
	for _, c := range in.Cases {
		if seen[c.Name] {
			return nil, fmt.Errorf("duplicate case name %q", c.Name)
		}
		seen[c.Name] = true
		var records []storage.UsageRecord
		domain := ""
		for _, r := range c.Records {
			rec := storage.UsageRecord{At: time.Unix(0, 0), Provider: r.Provider, Model: r.Model, Status: r.Status}
			if r.Tier != nil {
				rec.ServiceTier = *r.Tier
				rec.EmptyServiceTier = *r.Tier == ""
			}
			fields := map[string]**int{"input_tokens": &rec.Usage.InputTokens, "output_tokens": &rec.Usage.OutputTokens,
				"total_tokens": &rec.Usage.TotalTokens, "cached_input_tokens": &rec.Usage.CachedInputTokens,
				"cache_write_tokens": &rec.Usage.CacheWriteTokens, "reasoning_tokens": &rec.Usage.ReasoningTokens}
			for key, dst := range fields {
				text := r.Usage[key]
				if text == nil {
					continue
				}
				n, ok := new(big.Int).SetString(*text, 10)
				if !ok || n.Sign() < 0 {
					return nil, fmt.Errorf("case %q: bad count %q", c.Name, *text)
				}
				if n.Cmp(maxInt) > 0 {
					domain = fmt.Sprintf("count %s exceeds Go's signed 64-bit int", *text)
					continue
				}
				*dst = intp(int(n.Int64()))
			}
			records = append(records, rec)
		}
		if domain != "" {
			cases = append(cases, caseOut{Name: c.Name, OutOfDomain: domain, Estimates: []costOut{}})
			continue
		}
		out := caseOut{Name: c.Name, Estimates: []costOut{}}
		for _, r := range records {
			out.Estimates = append(out.Estimates, costJSON(pricing.Request(r)))
		}
		if total := pricing.Total(records); total != nil {
			t := costJSON(*total)
			out.Total = &t
			out.Short = pricing.Short(total)
			out.Describe = pricing.Describe(total)
		} else {
			out.Short = pricing.Short(nil)
			out.Describe = pricing.Describe(nil)
		}
		cases = append(cases, out)
	}
	type moneyOut struct {
		Amount string `json:"amount"`
		Text   string `json:"text"`
	}
	money := []moneyOut{}
	for _, text := range in.Money {
		r, ok := new(big.Rat).SetString(text)
		if !ok {
			return nil, fmt.Errorf("bad money %q", text)
		}
		money = append(money, moneyOut{Amount: text, Text: pricing.FormatMoney(r)})
	}
	return map[string]any{"version": pricing.Version, "sources": pricing.Sources, "cases": cases, "money": money}, nil
}

// ----- storage-write -----

type writeSpec struct {
	File      string `json:"file"`
	ID        string `json:"id"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	Messages  []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
	Requests []pricingRecordAt `json:"requests"`
}

type pricingRecordAt struct {
	At       string             `json:"at"`
	Provider string             `json:"provider"`
	Model    string             `json:"model"`
	Tier     *string            `json:"tier"`
	Status   string             `json:"status"`
	Usage    map[string]*string `json:"usage"`
}

func storageWrite(specPath, dir string) error {
	data, err := os.ReadFile(specPath)
	if err != nil {
		return err
	}
	var specs []writeSpec
	if err := json.Unmarshal(data, &specs); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for _, s := range specs {
		created, err := time.Parse(time.RFC3339Nano, s.CreatedAt)
		if err != nil {
			return err
		}
		updated, err := time.Parse(time.RFC3339Nano, s.UpdatedAt)
		if err != nil {
			return err
		}
		c := storage.Conversation{ID: s.ID, CreatedAt: created, UpdatedAt: updated, Provider: s.Provider, Model: s.Model}
		for _, m := range s.Messages {
			c.Messages = append(c.Messages, llm.Message{Role: llm.Role(m.Role), Content: m.Content})
		}
		for _, r := range s.Requests {
			at, err := time.Parse(time.RFC3339Nano, r.At)
			if err != nil {
				return err
			}
			rec := storage.UsageRecord{At: at, Provider: r.Provider, Model: r.Model, Status: r.Status}
			if r.Tier != nil {
				rec.ServiceTier = *r.Tier
				rec.EmptyServiceTier = *r.Tier == ""
			}
			fields := map[string]**int{"input_tokens": &rec.Usage.InputTokens, "output_tokens": &rec.Usage.OutputTokens,
				"total_tokens": &rec.Usage.TotalTokens, "cached_input_tokens": &rec.Usage.CachedInputTokens,
				"cache_write_tokens": &rec.Usage.CacheWriteTokens, "reasoning_tokens": &rec.Usage.ReasoningTokens}
			for key, dst := range fields {
				if text := r.Usage[key]; text != nil {
					n, ok := new(big.Int).SetString(*text, 10)
					if !ok || !n.IsInt64() {
						return fmt.Errorf("count %q is outside Go's signed 64-bit range", *text)
					}
					*dst = intp(int(n.Int64()))
				}
			}
			c.Requests = append(c.Requests, rec)
		}
		bytes, err := storage.EncodeConversation(c)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, s.File), bytes, 0o600); err != nil {
			return err
		}
	}
	return nil
}
