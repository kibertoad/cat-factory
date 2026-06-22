---
'@cat-factory/app': minor
---

Default models picker: show each model's list price alongside its name and context.

The per-agent-kind model dropdown in the "Default models for agents" settings
window previously labelled each option with only the model name, provider, and
context window (e.g. `Qwen3 · DashScope · 32K`). It now also appends the model's
informational list price — already resolved from spend pricing on the catalog —
so you can weigh cost while picking (`Qwen3 · DashScope · 32K · 1.1/5.5 EUR per
Mtok`). Quota-based subscription models render their quota burn rate instead.
Reuses the existing `costLabel` helper; no backend change (the catalog already
carries `cost`).
