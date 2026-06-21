---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/agents': patch
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/spend': patch
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/executor-harness': minor
'@cat-factory/app': minor
---

Add alternate subscription-backed coding harnesses (Claude Code / Codex) alongside
the Pi proxy harness.

- New per-workspace **subscription token pool** (`provider_subscription_tokens`,
  D1 + Postgres, encrypted at rest) with usage-aware rotation, behind a kernel
  port + `ProviderSubscriptionService`, wired into all three runtimes.
- A guided **LLM Vendors** navbar UI to connect Claude / Codex / GLM (Z.ai) /
  Kimi (Moonshot) subscription credentials (token pool, write-only).
- The executor-harness image now bundles the Claude Code and Codex CLIs; the
  harness selects `pi` / `claude-code` / `codex` per job from the model, and the
  subscription harnesses authenticate direct-to-vendor (no proxy) and report token
  usage from the CLI event stream for rotation + telemetry.
- The model catalog becomes a canonical-model → provider map with precedence
  **subscription > direct > cloudflare** ("subscriptions always win"): latest
  Opus/Sonnet + GPT-5.5/5.4 (subscription-only), GLM-5.2/Kimi gain a Claude-Code
  subscription flavour, and `ModelOption` now carries per-flavour cost, context
  window, and a `quotaBased` flag (subscription usage is flat-rate quota, never
  billed against the spend budget).
