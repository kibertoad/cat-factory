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

**Two facade gaps that closed with it**, both silent before:

- The Node LLM-proxy upstream kept its own provider→env table, which omitted `xai`. A Pi step
  pinned to Grok-direct passed the dispatch guard (`isProxyableProvider('xai')` is true) and then
  failed as "upstream not available". That table is gone; the upstream resolves through
  `baseUrlForNode`, the same resolution the inline path takes.
- The Worker's typed env override map was a loose `Record<string, …>` and omitted `xai` too, so the
  documented `XAI_BASE_URL` was consumed by neither facade. It is now total over
  `OpenAiCompatibleProvider`, so a provider missing from it is a type error.

**For operators**: `BIFROST_BASE_URL` is new (CF + Node), and `XAI_BASE_URL` now actually takes
effect on the Worker — a deployment that set it expecting a regional or proxied xAI endpoint was
silently reaching `api.x.ai` and will now reach what it configured.
