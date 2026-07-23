---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Enable/disable + pinned default for the two credential pools (subscription tokens and
direct-provider API keys).

A pool can hold several credentials "for the same thing" — several subscription tokens per
(workspace, vendor), or several API keys per (scope, provider). Previously the only lever was
delete, and selection was pure usage-aware rotation. Now each credential carries two lifecycle
flags, editable via a new `PATCH` endpoint (`{ enabled?, isDefault? }`):

- **Enable / disable** — a disabled credential stays in the pool (still listed and
  re-enablable) but is never leased and no longer makes its vendor/provider "configured", so
  the model picker and pipeline-start guard treat an all-disabled provider as unconfigured.
- **Pinned default** — one credential per group can be pinned as the preferred one; it is
  leased in preference to usage-aware rotation. At most one default per group (setting one
  clears the prior), and a disabled default is ignored (leasing falls back to rotation among
  the remaining enabled credentials).

New wire fields `enabled` / `isDefault` on `apiKeySchema` + `vendorCredentialSchema`; new
`PATCH /workspaces/:ws/vendor-credentials/:id`, `PATCH …/api-keys/:id` (workspace + `/me` +
account scopes). Persisted as `enabled` / `is_default` columns mirrored across all three stores
(D1, Drizzle/Postgres, and the local `node:sqlite` credential store), with the lease/list
queries filtering disabled and ordering the default first. The **LLM Vendors** UI gains a
default toggle + an enable/disable switch per credential. A new cross-runtime conformance suite
asserts the enable/disable + default behaviour against every store.

This is an additive, backwards-compatible schema change: existing credentials read as enabled
and not-default, so behaviour is unchanged until an operator opts in.
