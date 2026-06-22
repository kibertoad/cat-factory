---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/app': patch
---

Refuse to pool individual-use-only subscriptions on a workspace.

Some subscriptions are licensed for individual use only, so a single credential may not
be shared across a workspace (any member's run leasing it). `SUBSCRIPTION_VENDORS` now
carries an `individualOnly` flag, set — from each vendor's own terms of service — for
`claude` (Anthropic consumer Pro/Max), `glm` (Z.ai's GLM Coding Plan is "licensed only
to the individual natural person") and `codex` (a ChatGPT `auth.json` is a per-seat
credential, sharing prohibited at every tier). The genuinely org-permitted coding-plan
vendors `kimi` (Moonshot explicitly permits authorized enterprise use) and `deepseek` (a
commercial API platform) stay poolable.

`ProviderSubscriptionService` enforces it account-agnostically: `addToken`/`leaseToken`
throw a `ConflictError` (HTTP 409) for any `individualOnly` vendor, and `hasToken` always
reports it unavailable so the executor's "subscriptions always win" routing never
auto-selects a vendor a lease would reject. The rule is asserted in the cross-runtime
conformance suite against an org-owned workspace, and the LLM Vendors UI offers only the
poolable vendors (the individual-use ones are connected per-user in the Personal
subscriptions section). Organizations needing shared, programmatic access use a direct
provider API key instead, which is unaffected by the flag.
