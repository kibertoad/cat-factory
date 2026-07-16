---
'@cat-factory/server': minor
'@cat-factory/node-server': patch
---

feat(mothership): expose member-display user reads over the persistence RPC

A mothership-mode local node delegates org/durable state to the mothership, but the account members
panel could not enrich its roster with real display details — `userRepository.get`/`listByIds` were
not remotely callable, so names/emails/avatars came back empty. This allow-lists those two
member-display reads.

- A new scope-rule pair **`user`/`userList`** in the persistence RPC (`src/persistence/rpc.ts`).
  A userId is neither an account nor a workspace, so it is bound by CO-MEMBERSHIP: a user's display
  record is readable iff they are a member of one of the machine token's in-scope accounts, resolved
  server-side from the account rosters via a new `resolveAccountMemberIds` dispatch resolver (bounded
  by the token's account scope, not the requested user list — no N+1). A user in no in-scope account
  fails closed (404, no existence leak), like every other entity scope.
- The shared `PersistenceController` wires `resolveAccountMemberIds` from
  `membershipRepository.listByAccount`, so both facades (Node + Cloudflare mothership) pick it up.

Safe because the reads carry only the presentational `UserRecord` (id/name/email/avatarUrl/createdAt);
the password `secret` lives on `UserIdentityRecord`, reachable only via `getIdentity`/`listIdentities`,
which — with the `update` profile write and `findByIdentity`/`findByEmail` — stay off the machine API
(the account-lifecycle / login surface). See `docs/initiatives/mothership-mode.md`.

The `@cat-factory/node-server` patch is a test-only change: its mothership-allowlist drift guard moves
`userRepository.get`/`listByIds` out of `pending` to reflect the new remote surface.
