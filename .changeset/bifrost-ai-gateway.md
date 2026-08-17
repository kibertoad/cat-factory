---
'@cat-factory/agents': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/spend': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Support Bifrost as an AI gateway, and make the OpenAI-compatible provider set one table both
runtimes derive from.

`bifrost` joins the workspace API-key pool and the model catalog (`bifrost-default`) as the second
operator-hosted gateway beside LiteLLM: self-hosted software with no public instance, so it is
proxyable and key-poolable but resolves only once the deployment sets `BIFROST_BASE_URL`. Until then
its pooled key is inert and its catalog entry reads `available: false`, rather than passing the start
guard and failing at dispatch. Its catalog default is `openai/gpt-4o`, a real id on any Bifrost whose
OpenAI provider is configured, because Bifrost names models by their canonical `provider/model` pair
rather than by operator-coined aliases.

**The seam it landed through.** `OPENAI_COMPATIBLE_ENDPOINTS` (`@cat-factory/agents`
`providers/endpoints.ts`) is now the ONE table naming every OpenAI-compatible provider and the
endpoint it defaults to, `null` marking an operator-hosted one. Everything else is derived from it:
the built-in base URLs, `UI_CONFIGURABLE_DIRECT_PROVIDERS`, `isProxyableProvider`, the new
`isOpenAiCompatibleProvider` / `isOperatorHostedGateway` predicates, and the `OperatorHostedGateway`
union that the base-URL remedy's display names are an exhaustive `Record` over. Adding a provider is
one entry there, and the compiler finds the rest.

**Four facade gaps that closed with it**, every one of them silent before:

- The Node LLM-proxy upstream kept its own provider→env table, which omitted `xai`. A Pi step
  pinned to Grok-direct passed the dispatch guard (`isProxyableProvider('xai')` is true) and then
  failed as "upstream not available". That table is gone; the upstream resolves through
  `baseUrlForNode`, the same resolution the inline path takes.
- `workers-ai` was the SAME bug from the other side: the dispatch guard is runtime-neutral and
  admits it everywhere, the catalog offers every Cloudflare model once the REST credentials are set,
  and only the Worker (which has the `AI` binding) had a route. A container step on Node died at its
  first proxy call with "Provider 'workers-ai' is not available". Node now forwards it to
  Cloudflare's own OpenAI-compatible endpoint, carrying the account token on the resolved endpoint
  because `workers-ai` owns no pooled key. The proxy prefers an in-process route and falls back to
  the forward path, reporting the provider unavailable only when neither resolves.
- The Worker's typed env override map was a loose `Record<string, …>` and omitted `xai` too, so the
  documented `XAI_BASE_URL` was consumed by neither facade. It is now total over the shared
  `DirectProvider` union, so a provider missing from it is a type error.
- That union is the direct providers, not just the OpenAI-compatible ones, which closes
  `ANTHROPIC_BASE_URL`: Node reads env by name and always honoured it, the Worker never declared it.
  The container proxy still refuses `anthropic` (its own SDK dialect would reject an OpenAI-shaped
  body), and refuses it by the table's predicate rather than by "did a base URL resolve", those two
  answers now differing for exactly that provider.

**Metering**: the shipped `bifrost-default` entry routes `openai/gpt-4o`, so it is priced at that
model's own direct rate rather than the generic gateway fallback, which would have under-counted it
about sixteenfold against a workspace budget.

**For operators**: `BIFROST_BASE_URL` is new (CF + Node). `XAI_BASE_URL` now actually takes effect on
the Worker, and `ANTHROPIC_BASE_URL` on the Worker at all: a deployment that set either expecting a
regional or proxied endpoint was silently reaching the public API and will now reach what it
configured. Both, plus the rest of the `${VENDOR}_BASE_URL` family, are documented in
`docs/environment-variables.md` and reserved against being named as a capability credential, which
they were not before. `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` is now read in one place on
Node, so a whitespace-only value counts as unset everywhere instead of enabling the picker only.
