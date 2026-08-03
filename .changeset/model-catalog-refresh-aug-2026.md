---
'@cat-factory/kernel': minor
'@cat-factory/spend': minor
'@cat-factory/cli': minor
'@cat-factory/app': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Refresh the model catalog against what the providers actually serve (Aug 2026). Several
curated entries pointed at ids their provider has since retired, so the model was
un-runnable rather than merely dated:

- **Cloudflare Workers AI**: `@cf/meta/llama-3.1-8b-instruct` and `@cf/moonshotai/kimi-k2.5`
  were deprecated on 30 May 2026. `cloudflare-llama` now serves `llama-4-scout` (131K,
  tool calling) and the `kimi-k2.5` entry is removed. The `conflict-resolver` routing
  default on BOTH runtimes pointed at the deprecated K2.5 and moves to K2.6. Adds
  `gpt-oss-120b` and `glm-flash` (GLM-4.7 Flash) as the missing open-weights and
  cheap-tier options.
- **ChatGPT / Codex**: `gpt-5.5-codex` and `gpt-5.4-codex` were never valid Codex
  `--model` slugs (the `-codex` family ended at GPT-5.3), so both entries failed with
  `Unknown model`. The catalog now carries the GPT-5.6 tiers Codex actually serves —
  `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` — plus plain `gpt-5.5`. **The `gpt-5.4`
  entry is removed** (Codex retires it for ChatGPT sign-ins on 31 Aug 2026); a block
  pinned to it falls through to the workspace/deployment default.
- **DeepSeek**: the `deepseek-chat` alias was retired on 24 Jul 2026 in favour of the V4
  pair. The `deepseek` entry moves to `deepseek-v4-flash` (1M context) across its direct,
  OpenRouter and subscription flavours, and `deepseek-v4-pro` gains direct + OpenRouter
  flavours beside its Cloudflare one.
- **OpenRouter**: `google/gemini-3-pro` no longer exists on the gateway — the `gemini`
  entry moves to `google/gemini-3.1-pro-preview`. Adds gateway routes for GLM-5.2 and
  Qwen, and a `kimi-k3` entry.
- Claude Sonnet moves from 4.6 to 5; Qwen's direct flavour from `qwen3-max` to
  `qwen3.7-max`.

Spend pricing gains per-model entries for every Workers AI model that is billed per
token rather than by neuron. **GLM-5.2 — the architect/reviewer routing default — and the
DeepSeek R1 distill had none, so they were metering at the near-free neuron rate and
escaping the budget gate.**
