---
'@cat-factory/kernel': minor
'@cat-factory/spend': patch
'@cat-factory/app': patch
---

Add Claude Fable 5 to the model catalog. `claude-fable` runs via the Claude Code
subscription harness (Anthropic's most capable model, 1M context) with an
OpenRouter pay-as-you-go flavour, mirrors the existing `claude-opus` entry, and
carries its own spend pricing ($10 in / $50 out per 1M) plus an OpenRouter
recommended-slug entry.
