---
'@cat-factory/executor-harness': minor
'@cat-factory/server': minor
---

Install the `@juicesharp/rpiv-web-tools` Pi extension in the executor-harness image
so container agents (coder, ci-fixer, mocker, blueprints, analysis, …) can use
`web_search` / `web_fetch`. Enablement is conditional on a provider being configured
in the container env — the harness auto-detects a configured backend (e.g.
`BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, or `SEARXNG_URL`), selects it in
`~/.config/rpiv-web-tools/config.json`, and surfaces usage guidance in the agent
context; `WEB_SEARCH_PROVIDER` pins the active provider explicitly. No provider is
enabled (and no key is baked into the image) unless configured. The two web tools are
treated as read-only exploration by the no-progress guard.

The guidance is tailored per agent kind: `ContainerAgentExecutor` composes a kind-aware
web-research nudge (via `@cat-factory/agents`' `webResearchGuidanceFor`) and passes it
in the job body, which the harness surfaces only when web search is configured (falling
back to a generic blurb otherwise). Changes the image, so the harness version (its GHCR
image tag) bumps.
