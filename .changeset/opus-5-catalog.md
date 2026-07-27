---
'@cat-factory/kernel': minor
'@cat-factory/conformance': minor
'@cat-factory/spend': patch
'@cat-factory/local-server': patch
'@cat-factory/orchestration': patch
'@cat-factory/app': patch
'@cat-factory/cli': patch
---

Add Claude Opus 5 support: the `claude-opus` catalog entry rolls forward from Opus 4.8 to
Opus 5, with its own spend pricing and an updated OpenRouter recommended slug.

- `@cat-factory/kernel`: `MODEL_CATALOG`'s `claude-opus` entry now resolves to Anthropic's
  **Claude Opus 5** — subscription ref `anthropic:claude-opus-5` (Claude Code harness, 1M
  context, previously left implicit) and OpenRouter ref `anthropic/claude-opus-5`. This
  mirrors how the entry already tracked the current Opus across 4.6 → 4.7 → 4.8, so a block
  pinned to `claude-opus` picks up Opus 5 with no migration. **Breaking (pre-1.0,
  acceptable):** Opus 4.8 is no longer a curated catalog entry — a workspace that wants it
  specifically reaches it through the dynamic per-workspace OpenRouter catalog.
- `@cat-factory/kernel`: the built-in `mdp_claude` model preset is renamed to "Claude
  Opus 5" and its catalog `version` bumped to `2`, so existing workspaces get the usual
  reseed advisory for the built-in they still hold under the old name.
- `@cat-factory/spend`: adds `anthropic:claude-opus-5` and
  `openrouter:anthropic/claude-opus-5` price entries at Opus-tier list price ($5 in / $25
  out per 1M, ~4.6 / 23 EUR). The Opus 4.8 entries are kept so historical spend rows and
  OpenRouter passthroughs still cost correctly.
- `@cat-factory/app`: "Enable recommended" in the OpenRouter catalog panel now offers
  `anthropic/claude-opus-5` instead of `anthropic/claude-opus-4.8`, matching the curated
  backend refs.
- `@cat-factory/cli` / `@cat-factory/local-server` / `@cat-factory/orchestration`: picker
  label and doc comments follow the catalog ("Claude Opus 5").
- `@cat-factory/conformance`: the model-preset suite asserts the new `mdp_claude` catalog
  version.
