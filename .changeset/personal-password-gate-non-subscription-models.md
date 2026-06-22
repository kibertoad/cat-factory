---
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/app': patch
---

Personal-password prompt: per-user dual-mode resolution + accurate model context sizes.

The individual-usage credential gate now prompts for a personal password exactly when
dispatch will actually lease one, per user:

- A subscription-only individual model (Claude / Codex) always needs the personal
  credential (no fallback).
- A DUAL-MODE individual model (GLM, which also has a Cloudflare base) is per-user: a user
  who has connected their own GLM subscription runs on it (gated on their password), while
  a user without one falls back to Cloudflare GLM with no prompt. Dispatch
  (`ContainerAgentExecutor.resolveEffectiveRef`) and the gate now share this decision via a
  new `hasPersonalSubscription(userId, vendor)` seam wired in both runtime facades, so the
  two can't drift. Previously GLM-on-Cloudflare always prompted (the gate keyed off "the
  model has an individual subscription flavour" rather than "this user will use it").
- A block pinned to any non-subscription model (Cloudflare / Bedrock / direct) is never
  gated just because a workspace per-kind default happens to be an individual model — a
  resolvable block pin wins for every step, mirroring `resolveStepModelRef`.

The precedence is a pure, unit-tested `resolveIndividualVendors` +
`personalCredentialVendorForModelId`.

Frontend: cancelling the personal-password modal now reverts the task's optimistic
"Starting…" state instead of leaving it stuck until reload. `withCredential` awaits the
prompt and reports whether the action ran or was cancelled.

Model catalog context windows corrected from each provider's own docs (the field is now
documented as the per-flavour served window, which can be larger or smaller per provider):
Llama 3.1 7,968; Qwen3-30B 32,768; Kimi K2.6 / K2.7 256K on Cloudflare; DeepSeek R1 distill
80K on Cloudflare; DeepSeek V4 Pro 131,072; GLM-5.2 256K on Cloudflare and the full 1M via a
Z.ai subscription. The "cut NNK on Cloudflare" wording in the Kimi/GLM/DeepSeek descriptions
was inaccurate and is rewritten.

Also: the board shows an empty-state invite (bootstrap a repo / add from an existing repo)
when it has no service frames.
