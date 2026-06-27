---
'@cat-factory/agents': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

Centralize OpenAI-compatible provider base-URL resolution.

The env-override→default base-URL logic (and the "litellm has no public default" rule)
was reconstructed per facade — a `NODE_BASE_URLS` map plus a `||` lookup on Node and a
provider `switch` on the Worker. Both now route through a single
`resolveOpenAiCompatibleBaseUrl(provider, override)` in `@cat-factory/agents`, driven by
the existing `DEFAULT_OPENAI_COMPATIBLE_BASE_URLS` table, so adding an OpenAI-compatible
vendor is a one-line table entry both runtimes pick up automatically.

Minor behavioural alignment: a _blank_ `${PROVIDER}_BASE_URL` override now falls back to
the built-in default on the Worker too (it previously returned the empty string), matching
Node's long-standing `||` semantics.
