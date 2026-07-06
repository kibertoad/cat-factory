---
'@cat-factory/kernel': patch
'@cat-factory/workspaces': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/conformance': patch
---

Fix a first-sign-in race in `AccountService.ensurePersonalAccount` that 500'd
`GET /accounts` ("cannot reach backend") on a fresh DB.

The method was a non-atomic check-then-act: concurrent first-load requests all read
"no personal account yet", then all `INSERT`, so all but one failed with a duplicate-key
violation on the personal-account partial unique index (`idx_accounts_personal`) and the
error surfaced as an unhandled 500.

The create path is now atomic. A new `AccountRepository.ensurePersonal(account)` port
inserts-or-returns the surviving row — D1 via `INSERT OR IGNORE`, Postgres via
`ON CONFLICT DO NOTHING` — so concurrent first-sign-in callers all converge on the same
account with no rejection. Both runtimes implement it and a cross-runtime conformance
assertion fires the concurrent resolution and asserts a single account results.

The sibling paths are unaffected: `createOrg` is a deliberate non-idempotent create (org
accounts have no such unique index), and `ensureMembership` already writes through an
idempotent `upsert`.
