---
'@cat-factory/kernel': minor
'@cat-factory/spend': patch
---

Add Claude Haiku 5.5 to the model catalog and the price table, and correct the two gateway price rows that had fallen below their route.

New catalog entry, declared only on routes verified to serve that exact model:

- `claude-haiku-5-5` (Claude Haiku 5.5, 2026-10-07): Claude Code subscription, AWS Bedrock (`anthropic.claude-haiku-5-5`) and OpenRouter (`anthropic/claude-haiku-5.5`). It is the one two-band Claude model: $0.10 / $0.50 per 1M for a prompt up to 100,000 tokens and $0.50 / $2.50 for the whole request past it, so both its direct and its gateway row carry a long band at that threshold.

Price corrections, both in the safe direction: `openrouter:deepseek/deepseek-v4-flash` output moves to 1.18 EUR/1M (the retired slug's blend now bills $1.28 out), and `openrouter:moonshotai/kimi-k3` names its cache read at 0.51 EUR/1M, the gateway's $0.55 blend, which sat above the derived 0.1x floor. The `anthropic:claude-sonnet-5-5` note now states its real 0.05x cache read; the row was already on the safe side.
