---
'@cat-factory/worker': patch
---

Fix DeepSeek V4 Pro failing with an unknown-model error on the Worker.

`deepseek/deepseek-v4-pro` is a `<provider>/<model>` AI-catalog slug, not a native
`@cf/...` id. It was wired through workers-ai-provider's experimental AI-Gateway
delegate (`createWorkersAI({ providers: [openai] })`), whose static provider table
classifies `deepseek` as a BYOK, non-run-catalog provider — so the call needs a
`"default"` AI Gateway with catalog billing plus a stored DeepSeek key, neither of
which exists, and it fails.

Per Cloudflare's docs the model is a unified-billing run-catalog model (served via
Fireworks) reachable directly with the account's own Workers AI binding/token — no AI
Gateway, no BYOK. The Worker's in-process LLM upstream now detects a catalog slug and
runs it through `binding.run` directly in the OpenAI Chat Completions shape (native
`@cf/...` ids are unchanged, still going through the AI SDK). The gateway-delegate
plugin is dropped.
