---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Block individual-only subscriptions (Claude) on organization-owned workspaces.

Anthropic's consumer Claude subscription is licensed for individual use only, so a
pooled Claude OAuth token may not be shared across an org. `SUBSCRIPTION_VENDORS` now
carries an `individualOnly` flag (set for `claude`), and `ProviderSubscriptionService`
enforces it: a workspace whose owning account is an `org` may neither connect
(`addToken`) nor lease (`leaseToken`) such a vendor, and `hasToken` reports it as
unavailable so the executor's "subscriptions always win" routing never auto-selects a
vendor lease would reject. Personal and legacy/unscoped workspaces are unaffected, and
the commercial coding-plan vendors (GLM/Kimi/DeepSeek) stay available to orgs.

The rule is wired symmetrically into both runtimes (Cloudflare + Node/local resolve
the owning account via the shared `AccountRepository`) and asserted in the
cross-runtime conformance suite against an org-owned workspace.
