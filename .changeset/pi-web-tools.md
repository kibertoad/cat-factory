---
'@cat-factory/executor-harness': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Give container agents (coder, ci-fixer, mocker, blueprints, analysis, …) `web_search` /
`web_fetch` via the `@juicesharp/rpiv-web-tools` Pi extension installed in the
executor-harness image — without putting a search-provider key in the sandbox.

The backend hosts a SearXNG-compatible **web-search proxy** at `${proxyBaseUrl}/web-search`
(`webSearchProxyController`, mounted under the LLM proxy's public `/v1`). A container
authenticates with the SAME short-lived, model-locked session token it uses for the LLM
proxy; the facade verifies it and runs the search server-side through the `webSearch`
runtime gateway, under the deployment's own provider key. Two upstreams ship: Brave
(`WEB_SEARCH_BRAVE_API_KEY`, the recommended one-key path, what Claude Code uses) and a
reverse proxy to a self-hosted SearXNG (`WEB_SEARCH_SEARXNG_URL` [+ `_API_KEY`]). Both
runtime facades wire it from env, so it works on Cloudflare (where per-run container env
vars can't be injected) and on the Node self-hosted runner pool alike — no provider
secret ever enters the container, matching the LLM-proxy posture.

When the proxy is configured, `ContainerAgentExecutor` sets `webSearch: true` on the
coding/ci-fixer job body; the harness then points rpiv-web-tools' SearXNG provider at the
proxy (the token as its bearer) and surfaces a kind-aware usage nudge (via
`@cat-factory/agents`' `webResearchGuidanceFor`). Self-hosted runner pools may still
configure a provider key directly in the container env (auto-detected as before); an
explicit `WEB_SEARCH_PROVIDER` pin now requires that provider's credential to be present
so the agent is never told about a tool that would error. The two web tools count as
read-only exploration for the no-edit guard, but a dedicated cap
(`JOB_MAX_CONSECUTIVE_WEB_CALLS`, default 25) stops a search rabbit-hole.

Changes the image, so the harness version (its GHCR image tag) bumps.
