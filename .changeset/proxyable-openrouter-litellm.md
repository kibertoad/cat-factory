---
"@cat-factory/agents": patch
"@cat-factory/server": patch
---

Fix: container agent (and repo-bootstrap) runs on **OpenRouter** and **LiteLLM** models
were rejected at start with `'openrouter' is not supported` even though the LLM proxy
already forwards both (their base URLs resolve in `resolveOpenAiCompatibleUpstream`). The
proxyability guard hardcoded only `qwen`/`deepseek`/`moonshot`/`openai`/`workers-ai` and
was duplicated (out of step) across `ContainerAgentExecutor` and `ContainerRepoBootstrapper`.
Replaced both copies with a single shared `isProxyableProvider` in `@cat-factory/agents`,
derived from `DEFAULT_OPENAI_COMPATIBLE_BASE_URLS` (so every OpenAI-compatible direct
provider — including OpenRouter) plus the operator-hosted `litellm` gateway and the per-user
local runners, so the start guard and the proxy can no longer disagree.
