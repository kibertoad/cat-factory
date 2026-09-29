---
'@cat-factory/kernel': minor
'@cat-factory/spend': patch
'@cat-factory/app': patch
---

Add GPT-6.1 Sol and Claude Sonnet 5.5 to the model catalog and the price table, and name the GLM-5.2 gateway cache rate that had fallen below its route.

New catalog entries, each declared only on routes verified to serve that exact model:

- `gpt-6.1-sol` (GPT-6.1 Sol, 2026-09-29): Codex subscription and OpenRouter (`openai/gpt-6.1-sol`), two-band like every OpenAI row at $2 / $10 short and $4 / $15 long per 1M. Codex resolves the slug only from 0.159.0 onward. OpenRouter's `-pro` slug gets no entry: same model, same price, only a reasoning mode.
- `claude-sonnet-5-5` (Claude Sonnet 5.5, 2026-09-28): Claude Code subscription, AWS Bedrock (`anthropic.claude-sonnet-5-5`) and OpenRouter (`anthropic/claude-sonnet-5.5`), $2 / $10 per 1M like Sonnet 5.

The existing `gpt-6-sol` and `claude-sonnet` entries keep their ids and models, so a block pinned to GPT-6 Sol or Sonnet 5 runs what it ran before.

Price correction, in the safe direction: `openrouter:z-ai/glm-5.2` names its cache read again (0.21 EUR/1M), because the gateway's cached rate moved back above the 0.1x floor its input rate derives.

The SPA's "Enable recommended" OpenRouter set gains GPT-6.1 Sol and Sonnet 5.5.
