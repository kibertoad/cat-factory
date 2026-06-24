---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/spend': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

OpenRouter: dynamic multi-tenant catalog + flavour unification.

**Flavour unification.** A catalog model can now carry an `openrouter` flavour alongside
`cloudflare`/`direct`/`subscription`. `effectiveVariant` resolves in the precedence
direct → openrouter → cloudflare (the subscription override still wins in `ModelRouter`),
so the SAME logical model routes through OpenRouter when only an OpenRouter key is
configured, and through its native vendor when that key is present. The standalone
`openrouter-*` catalog entries are folded into their native twins: `deepseek`, `gpt-5.5`
and `claude-opus` gain an `openrouter` route; Gemini 3 Pro becomes a curated `gemini`
entry. **Breaking (pre-1.0, acceptable):** the catalog ids `openrouter-claude-opus`,
`openrouter-gpt`, `openrouter-deepseek`, `openrouter-gemini-pro` and `openrouter-llama`
are removed — a block pinned to one falls through to default routing.

**Dynamic catalog.** A workspace can now browse OpenRouter's live `/models` and enable a
subset in the UI (the new "OpenRouter models" panel), rather than a hardcoded handful.
Enabled models surface in the per-workspace picker as `openrouter:<slug>` entries with
their live context window and price (overlaid onto the spend table, so budgets meter
accurately). Persisted in a new generic per-workspace `provider_model_catalog` table
(D1 ⇄ Drizzle, keyed by `(workspace_id, provider)` so future gateways like LiteLLM reuse
it), behind the new kernel `ProviderModelCatalogRepository` port and the
`OpenRouterCatalogService` (refresh leases the workspace's pooled OpenRouter key). New
routes: `GET|PUT /workspaces/:ws/openrouter/catalog`, `POST /workspaces/:ws/openrouter/refresh`.
Cross-runtime conformance asserts the enabled-subset round-trip + catalog surfacing on
both D1 and Postgres.
