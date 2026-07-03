---
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Mothership mode: widen the persistence-RPC allow-list to four more repository surfaces (the
prompt-fragment library + two account-onboarding reads) so mothership-mode local nodes can drive
them against a hosted mothership. Adds two new scope rules, `owner` (an `(ownerKind, ownerId)`
positional pair) and `ownerField` (the same as record fields on `upsert`), which resolve a
`workspace` owner to its account and take an `account` owner as the accountId directly — so a
machine token scoped to one account can never read/write another tenant's rows.

- `promptFragmentRepository` — the tenant-scoped prompt-fragment library management surface
  (`listByOwner`/`get`/`softDelete` via the `owner` rule, `upsert` via `ownerField`). Rows carry no
  secrets and both tiers are member-level (account-tier routes guard on `requireMember`, not
  `requireAdmin`). The `sourceId`-keyed `listBySource` (repo-sync fan-out) stays mothership-internal.
- `fragmentSourceRepository` — the fragment-source library list + link (`listByOwner` via `owner`,
  `upsert` via `ownerField`). The `sourceId`-keyed `get`/`updateSyncState`/`softDelete` stay off —
  they back the repo-sync the mothership owns (its source service needs a GitHub client a mothership
  node lacks). Node routes both fragment repos through the `pickRepoSource`/`if (remoteRepos)` seam
  ONLY when the library is configured, so the module isn't spuriously turned on in mothership mode.
- `invitationRepository.listByAccount` — the account members panel's pending-invite read (member-level,
  `account` rule). Invite `create`/`setStatus` (admin-gated) + the pre-auth `findByTokenHash`/`get`
  accept-invite lookups stay off.
- `emailConnectionRepository.getByAccount` — the email-settings panel read (member-level, `account`
  rule). Its provider key rides a sealed `apiKeyCipher` blob (the repo never decrypts), so no
  plaintext crosses the machine API. Connect/disconnect (`upsert`/`softDelete`, admin-gated) stay off.
