---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/spend': minor
'@cat-factory/app': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Add **OpenRouter** and **LiteLLM** as model providers. Both are OpenAI-compatible, so
they reuse the existing inlined `openAiCompatibleResolver` path (no new dependency, no
dedicated package) and work for both inline engine calls and container coding agents via
the LLM proxy. Keys are onboarded per workspace/user through the UI key pool like the
other direct vendors; their base URLs are deployment config — OpenRouter defaults to the
public gateway (`OPENROUTER_BASE_URL` override optional), while LiteLLM is operator-hosted
so `LITELLM_BASE_URL` is required to enable it. Ships curated, direct-only catalog entries
(OpenRouter: Claude Opus, Gemini 3 Pro, GPT-5.5, DeepSeek, Llama 3.3; LiteLLM: a generic
gateway-default entry) with approximate pricing/context, overridable via
`SPEND_MODEL_PRICES`.

**Wire change:** `apiKeyProviderSchema` is widened with `'openrouter'` and `'litellm'`.
