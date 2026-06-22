---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': minor
'@cat-factory/provider-cloudflare': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

LLM key management overhaul: DB-backed, multi-scope, pooled provider API keys;
opt-in Cloudflare AI; provider-gated pipelines; account roles.

- **Direct-provider API keys move from env to the DB** (BREAKING). The
  OpenAI/Anthropic/Qwen/DeepSeek/Moonshot keys that were read from
  `*_API_KEY` env vars are now onboarded via the UI and stored encrypted (the
  shared `WebCryptoSecretCipher`, HKDF info `cat-factory:provider-api-keys`).
  They are pooled and leased with usage-aware rotation, and scoped to an
  **account, workspace, or user** — within a workspace the candidate pool merges
  the workspace's keys, its owning account's keys, and the run initiator's own
  user keys. Operators must re-enter their keys via the app after upgrading.
- **Cloudflare Workers AI is no longer assumed available.** It becomes a separate
  opt-in provider lib (like `provider-bedrock`), explicitly registered per
  deployment (the Worker `AI` binding; Node REST account/token). The unconditional
  `workers-ai` fallback is removed, so a bare deployment exposes no models until a
  key is added or the Cloudflare lib is enabled.
- **Model selectability is derived from what is configured**, and starting a
  pipeline is blocked when any step's canonical model has no usable provider
  (no direct key, no subscription, no registered registry).
- **Account roles** (admin / developer / product, combinable) layered on the
  membership model: only admins may modify org-account settings; a product member
  can be set as a task's responsible person and is notified when requirement review
  raises findings.
