---
'@cat-factory/workspaces': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

Fix account/identity orphaning on a dangling identity, and add referential integrity for the
user-identity lineage.

**Login no longer silently forks a new account.** `UserService.findOrCreateByIdentity` resolves
a user by inner-joining `users` onto `user_identities`, so it returned `null` for BOTH "never
seen this identity" and "identity row present but its `users` row is gone". The two were
conflated: a dangling identity (a `users` row removed out from under a still-present
identity/account/subscription) made login create a fresh, empty user + personal account,
silently stranding the original account and everything on it (subscriptions, secrets, settings)
with no error surfaced. It now distinguishes the two via the join-free `getIdentity` read and
**fails loudly** (logged, 500) on a dangling identity instead of forking, so the corruption is
caught and healed rather than masked.

**DB-level referential integrity (both runtimes).** Previously nothing referenced `users(id)` at
the schema level, so an unsafe delete orphaned dependent rows with no complaint. Add
`ON DELETE RESTRICT` foreign keys so a `users` row can no longer be dropped while any of these
still reference it:

- `user_identities.user_id → users(id)`
- `accounts.owner_user_id → users(id)`
- `personal_subscriptions.user_id → users(id)`
- `memberships.user_id → users(id)`
- `subscription_activations.user_id → users(id)`

Node/Postgres: five validating `ADD CONSTRAINT` FKs (Drizzle schema + generated migration).
Cloudflare/D1: migration `0046_user_identity_foreign_keys.sql` rebuilds the five tables with the
FKs (deferring FK enforcement to commit via `PRAGMA defer_foreign_keys`, like `0001_init`) and
also corrects `user_id` on `personal_subscriptions`, `memberships`, and `subscription_activations`
from `INTEGER` to `TEXT` (matching the canonical `usr_*` id and the Postgres columns).

No data migration. On a database that already contains orphaned rows, the validating Postgres
constraint (or the D1 table-copy) will fail at boot — that is the intended loud surfacing of
pre-existing corruption; re-point or remove the orphaned rows and re-run.
