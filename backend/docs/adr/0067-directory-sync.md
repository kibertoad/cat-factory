# ADR 0067: Directory sync for external systems

- **Status:** Accepted (implemented)
- **Date:** 2026-10-09
- **Context layer:** contracts (`directory.ts`, `public-api-keys.ts`), kernel ports
  (`directory-changes.ts`, `public-api-key-repositories.ts`), `@cat-factory/workspaces`'
  `DirectoryService`, `@cat-factory/integrations`' `directoryWebhook/` and `publicApi/`, the
  server's `/api/v1` directory and key controllers, both facades' repositories and sweeps, and the
  `sdk/webhooks` and `sdk/directory-sync` packages. User-facing page:
  [Drive Cat Factory from outside](https://www.catfactory.ai/extend/public-api.html#keeping-a-copy-of-the-directory-in-sync).

## Context

External systems want to treat cat-factory as the system of record for an account's people and
repositories: who is in the account, which workspaces they reach and with what role, and which
repositories each workspace links. Before this, `/api/v1` had no user, membership or account-level
reads, nothing recorded what changed, and a public-API key was bound to one workspace, so nothing
account-level had a credential to run under.

An integration keeping its own copy needs three things, each from a different channel: freshness
(a change reaches it quickly), completeness (nothing is missed, ever) and verifiability (drift is
detected and repaired).

## Decision

**1. A per-account change feed records which directory entity changed.** Every write to a user,
account membership, workspace, workspace membership or repo projection row appends a
`directory_changes` row `(account_id, seq, entity_type, workspace_id, entity_id, at)`, inside the
same transaction (Postgres) or batch (D1) as the write. The append lives in the repository, so no
writer can bypass it; a cascaded delete (a workspace) appends the rows it is about to remove first.
Rows name an entity and never carry its state.

`seq` is per account and assigned so that commit order equals `seq` order: Postgres writers take
`pg_advisory_xact_lock(<feed class>, hashtext(account_id))` before their first row write and assign
`MAX(seq) + ROW_NUMBER()`; on D1 the append rides the writer's batch, which SQLite serializes. Repo
sync re-upserts every row on every pass, so it appends only when a published field changed
(`changedDirectoryRepoIds`, shared by both facades).

**2. Public-API keys belong to an account and may be limited to a subset of its workspaces.**
`workspaceIds: string[] | null` (`null` = every workspace, including later ones), stored as an
`all_workspaces` flag plus a `public_api_key_workspaces` grant table. A workspace-scoped `/api/v1`
call names its workspace in `x-cat-factory-workspace`, which a key reaching one workspace may omit,
so every key minted before this keeps working. A key never mints or revokes one reaching further
than itself (`403 workspace_reach_exceeded`), and widening a key past the board it is minted from
in the app takes an account admin.

**3. `/api/v1/directory/*` serves keyset-paged snapshots and the feed.** The feed returns changes
after a cursor, each carrying the entity's CURRENT state, or `null` once it is gone or out of the
key's reach; hydration is one batched read per entity type. A snapshot walk carries the feed head
read before its first page (`asOfSeq`), so replaying from it after the last page covers whatever
changed mid-walk. The feed is pruned after `DIRECTORY_CHANGE_RETENTION_DAYS` (default 30), always
keeping each account's newest row; a cursor older than that, or ahead of the feed, is
`409 cursor_expired`. A snapshot cursor names the listing that issued it, so a cursor passed to
another listing is `422` with `details.reason: invalid_cursor` rather than a key bound that
silently skips rows. A key limited to some workspaces sees their workspaces, memberships and
repositories only and is refused users and account memberships (`403 account_scope_required`); its
feed omits those rows. That feed
also carries the `workspace` deletion of every workspace that no longer exists, because the
board's deletion drops the key's grant and filtering by current grants alone would never tell the
key that a board it mirrored is gone. The membership and repo deletions of that board stay hidden
(a membership names a user), so the client cascades the workspace deletion itself.

**4. Directory webhooks push the feed.** Account-level endpoints (`/api/v1/directory/webhooks`,
`admin` and account-wide keys only, at most 10) receive `directory.changed` pages or
`directory.resync_required`, signed with the notification webhooks' scheme, from a sweep that runs
every two minutes on both facades (the Worker's frequent cron, a Node timer). A sweeper takes a
per-endpoint lease (`lease_token`, held until `lease_until`, 60 seconds) before a push and moves
`delivered_seq` only after the push succeeds, so two sweepers never push overlapping pages, pages
arrive in feed order, a failed push is retried, and a page whose sweeper died is sent again once
the lease expires. A failed push is counted on `notification.delivery_failed` with
`channel: directory_webhook`. A malformed endpoint id is `400 invalid_webhook_id`.

**5. Two hand-written packages make a receiver cheap.** `@cat-factory/webhooks` verifies any signed
delivery (Web Crypto only; `gatekeeper-worker` re-exports it). `@cat-factory/directory-sync`
drives bootstrap, catch-up, push handling and reconciliation over a `DirectoryStore` the integrator
implements, whose one rule is: skip a record only when a strictly newer `seq` is held for its key,
and keep deletions as tombstones. The syncer applies a workspace deletion's cascade to the
memberships and repositories under it itself, and filters an account-level push down to its own
key's reach (read from `/api/v1/me`), so a restricted key's store matches what its feed and
snapshots would build.

## Rationale

- **State-based hydration rather than event payloads.** Recording which entity changed and serving
  its current state means a duplicate feed row is harmless, a hard-deleted row needs no soft-delete
  column, and a change read late is never stale. The cost is that the feed is not a history; nobody
  asked for one.
- **Appending in the repository rather than in services.** A dozen services write the directory
  (members, accounts, invitations, users, workspaces, repo sync, the workspace cascade). An append
  per service is a list that gets one wrong; an append per repository write cannot be skipped.
- **Commit order equal to `seq` order rather than a global sequence.** With a database sequence, a
  reader at cursor 9 can see 11 commit, move past it, and never see 10 when it commits a moment
  later. The per-account lock is what lets a short page advance the cursor straight to the head.
- **A delivery sweep rather than an emission inside each write.** The feed already orders every
  write, so one reader replaces instrumenting every writer, and a push and a poll cannot disagree
  about what a change carries. The price is latency bounded by the Worker's 2-minute cron.
- **At-least-once pushes with the feed as the guarantee, rather than a durable delivery queue.**
  [ADR 0030](./0030-public-api-surface.md) keeps webhook delivery free of an outbox; the feed makes
  one unnecessary here too, since a receiver that lost a push catches up by polling.
- **A request header for the workspace rather than a path segment.** Every existing `/api/v1` path
  and SDK method stays as it is, and resolution lives in `authorize`, so no workspace-scoped handler
  changed. The header is documented on the spec's auth scheme rather than as a parameter on every
  operation, which would have added an argument to every generated SDK method.

## Consequences

- **Any new writer of a directory table must append to the feed**, inside its transaction or batch,
  taking the per-account lock first on Postgres. A new cascade that removes members or repos must
  append their changes before deleting them.
- **Never prune an account's newest feed row**: `MAX(seq)` continues from it.
- **A restricted key's grants are trusted without an ownership read.** They are checked at mint, and
  a board is only ever linked to an account once (accountless to account). If boards become
  movable between accounts, `resolveWorkspace` must read the owner for restricted keys too.
- **`directory_changes` survives a workspace delete** (`WORKSPACE_CASCADE_SPECIAL_TABLES`): the
  deletion is itself what the feed publishes.
- **Directory webhooks are not wired on a mothership-mode node.** Endpoint management is
  account-admin configuration the role-blind machine token may not reach, and delivery is the
  mothership's own sweep; the node answers 503 for those routes. The directory reads are on the
  persistence RPC allow-list, account-bound.
- **Every push body is in the spec's OpenAPI 3.1 `webhooks` section** (`scripts/openapi/webhooks.mjs`):
  a new delivery family adds its entry there and its component, or no client can type it.
- Delivered in [#2307](https://github.com/kibertoad/cat-factory/pull/2307) (feed),
  [#2308](https://github.com/kibertoad/cat-factory/pull/2308) (account keys),
  [#2309](https://github.com/kibertoad/cat-factory/pull/2309) (read API),
  [#2310](https://github.com/kibertoad/cat-factory/pull/2310) (webhooks) and
  [#2311](https://github.com/kibertoad/cat-factory/pull/2311) (packages).
