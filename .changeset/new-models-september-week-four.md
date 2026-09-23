---
'@cat-factory/kernel': minor
'@cat-factory/spend': minor
'@cat-factory/app': patch
---

Add the models released since the last catalog sweep, and correct the price rows that had fallen below their route.

New catalog entries, each declared only on routes verified to serve that exact model:

- `claude-opus-5-5` (Claude Opus 5.5, 2026-09-22): Claude Code subscription, AWS Bedrock (`anthropic.claude-opus-5-5`) and OpenRouter (`anthropic/claude-opus-5.5`), $4 / $20 per 1M.
- `gpt-6-sol` and `gpt-6-luna` (2026-09-22): Codex subscription and OpenRouter, two-band like every OpenAI row. Codex resolves both slugs only from 0.156.1 onward.
- `grok-4.7` (2026-09-21): direct xAI and OpenRouter, billed exactly as Grok 4.6.
- `glm-5.3-flashx`, `glm-5.3-prime` and `qwen3.8-max-prime`: faster serving tiers of models already in the catalog, at roughly twice the price, through OpenRouter. Each is its own entry so the speed-for-price trade is made per block.

The existing entries keep their ids and models, so a block pinned to Opus 5, Grok 4.6 or GLM-5.3 runs what it ran before.

Price corrections, all in the safe direction: `openrouter:openai/gpt-oss-120b` had fallen to a quarter of the gateway's listed rate and now names its cache read; `openrouter:z-ai/glm-5.3-flash` names the gateway's higher cache rate; the Workers AI gpt-oss-120b input and Llama 4 Scout output round up to Cloudflare's list instead of just under it.

The SPA's "Enable recommended" OpenRouter set gains Opus 5.5, GPT-6 Sol and Grok 4.7.
