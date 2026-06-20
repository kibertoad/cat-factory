---
'@cat-factory/agents': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Give the inline design/research agents (architect, researcher) provider-hosted web
search. The `AiAgentExecutor` now attaches the AI SDK's server-executed `web_search`
tool (Anthropic / OpenAI) to its one-shot call for an allow-listed set of kinds, plus
a usage nudge — so those agents can verify current libraries/APIs instead of relying
on training data, the same way Claude Code and Codex do. Opt-in and a no-op by
default: enabled per deployment via `INLINE_WEB_SEARCH_ENABLED` (with
`INLINE_WEB_SEARCH_KINDS` / `INLINE_WEB_SEARCH_MAX_USES` to tune the allow-list and
cap), and only on providers that expose a hosted search — models on Workers AI / the
OpenAI-compatible providers run unchanged. Both runtime facades wire it from env.
