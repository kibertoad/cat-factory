# Initiative: directory sync for external systems

**Status:** in progress: slice 1 (change feed recording) · **Owner:** core · **Started:** 2026-10-09

> This is the durable source of truth for a multi-PR initiative. Read it first before picking up
> the next slice; update the checklist at the end of each PR.

## Goal and rationale

External systems want to treat cat-factory as the system of record for an account's people and
repositories: who is in the account, which workspaces they can reach and with what role, and which
repositories each workspace has linked. Polling the session-authed SPA routes is neither possible
(no public endpoint lists users or members) nor fast (a full roster read per check).

The target: an integration keeps a local copy of the account's directory that is

- **fresh**: a change reaches it within seconds, through a signed webhook carrying the entity;
- **complete**: a missed or dropped webhook is recovered by pulling an ordered change feed from
  the integration's own cursor, never by guessing;
- **verifiable**: a periodic full reconciliation (snapshot plus feed replay) repairs any drift, and
  is the recovery path once a cursor falls out of the feed's retention.

And it is cheap to build: a hand-written Node package does the verification, deduplication, catch-up
and reconciliation, so the integrator writes only a storage adapter.

## Consumption model

The three channels have distinct jobs, and the design depends on keeping them distinct.

| Channel                          | Carries                                      | Guarantee                  | Job                     |
| -------------------------------- | -------------------------------------------- | -------------------------- | ----------------------- |
| Webhook (`directory.*`)          | the entity's current state plus its `seq`    | best-effort, at-least-once | latency                 |
| `GET /api/v1/directory/changes`  | ordered changes after a cursor               | complete within retention  | completeness            |
| `GET /api/v1/directory/{entity}` | a paged snapshot plus an `asOfSeq` watermark | point-in-time              | drift repair, bootstrap |

Webhook delivery stays inline and best-effort, exactly as [ADR 0030](../../backend/docs/adr/0030-public-api-surface.md)
designed it: no outbox, no delivery queue. Completeness comes from the feed, so a dropped delivery
costs latency until the next feed pull, never correctness. A receiver applies a delivery only when
its `seq` is newer than the `seq` it holds for that entity, which makes out-of-order and duplicate
deliveries harmless without contiguous-sequence gap detection. Contiguity cannot be promised anyway,
because a key restricted to some workspaces sees a filtered feed.

## Entities

Each change names one entity. The feed records WHICH entity changed; a reader hydrates its CURRENT
state at read time, and an entity that no longer exists (or is no longer visible to the reader) is
served as a deletion. State-based hydration is what makes duplicate change rows harmless and lets
hard-deleted rows (users, memberships) be represented without soft-delete columns.

| Entity                 | Key                    | Visible in account A when                                                        |
| ---------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `workspace`            | workspace id           | the workspace belongs to A                                                       |
| `user`                 | user id                | the user holds a membership in A                                                 |
| `account_membership`   | user id                | the membership row exists                                                        |
| `workspace_membership` | workspace id + user id | the row exists and its workspace belongs to A                                    |
| `repo`                 | workspace id + repo id | the `github_repos` row exists, is not tombstoned, and its workspace belongs to A |

A user is a global identity, so a profile change appends one change per account the user belongs
to. Adding or removing an account membership also appends a `user` change for that account, since
the user's visibility in it changed.

## Target design

### Change feed (`directory_changes`)

Append-only rows `(account_id, seq, entity_type, workspace_id, entity_id, at)`, primary key
`(account_id, seq)`. `seq` is per account, strictly increasing, and assigned so that COMMIT order
equals `seq` order. Without that a reader at cursor 9 could observe 11, advance past it, and never
see 10 when it commits a moment later.

- **Postgres**: every append runs inside the writing transaction, after
  `pg_advisory_xact_lock(<feed class>, hashtext(account_id))`. The lock serializes appenders per
  account until commit, so `MAX(seq) + ROW_NUMBER()` is safe and commit order matches.
- **D1**: the append is a statement in the same `db.batch` as the write. SQLite serializes writers
  and a batch is one transaction, so the same `MAX(seq) + ROW_NUMBER()` expression is safe.
- The append happens INSIDE the repository method that performs the write, never in the service
  calling it, so no writer can bypass the feed. A cascaded delete (workspace deletion) appends the
  rows it is about to remove in the same batch, before removing them.
- Repo sync re-stamps `synced_at` on every pass, so the repo writers append only for rows whose
  synced fields actually changed.
- **Retention**: rows older than the retention window are pruned, except the newest row per
  account, which must survive or `MAX(seq)` would restart and reissue sequence numbers.

### Account-level API keys with an optional workspace subset

A key belongs to an account. It may be limited to a subset of the account's workspaces; `null`
means every workspace, including ones created later. Existing keys become account keys restricted
to their one workspace, so their behaviour is unchanged.

- Workspace-scoped `/api/v1` routes resolve their workspace per request: from the
  `x-cat-factory-workspace` header when present, otherwise implicitly when the key is restricted
  to exactly one workspace. A key that could reach several workspaces and sends no header is
  refused with `details.reason: workspace_required`; a workspace outside the key's subset is a 404,
  matching how RBAC hides boards.
- `PublicApiKeyAuth.workspaceId` keeps meaning "the workspace this request acts on", resolved
  inside `authorize`, so the workspace-scoped controllers need no change.
- Directory routes are account-scoped and need no header. A restricted key sees `workspace`,
  `workspace_membership` and `repo` entities of its workspaces only. `user` and `account_membership`
  are account-wide facts, so a restricted key is refused their snapshots
  (`403 account_scope_required`) and its feed omits them. Its feed also carries the `workspace`
  deletion of every workspace that no longer exists: the board's deletion drops the key's grant, so
  filtering by current grants alone would never tell the key that a board it mirrored is gone. The
  membership and repo deletions of that board stay hidden (a membership names a user), so the
  client cascades the workspace deletion itself.
- This is additive under [ADR 0034](../../backend/docs/adr/0034-public-api-stability.md): no existing
  key or call changes meaning, and the header is optional for every key minted today.

### Public read API

- `GET /api/v1/directory/changes?after=<seq>&limit=` returns hydrated changes and `nextAfter`. A
  cursor older than retention, or ahead of the feed, is refused with `409`,
  `details.reason: cursor_expired`, which tells the client to reconcile from a snapshot.
- `GET /api/v1/directory/{workspaces,users,account-memberships,workspace-memberships,repos}`:
  keyset-paged snapshots. Every page carries the same `asOfSeq`, captured with the first page and
  echoed in the cursor; the client replays the feed from it after the last page.
- All `read` scope. New operations join `scripts/sdk/surface.mjs` under a `directory` group.

### Webhooks

Account-level endpoints (`/api/v1/directory/webhooks`, `admin` and account-wide keys only, at most
10 per account) receive the feed as signed pushes: `directory.changed` carrying a page of hydrated
changes, or `directory.resync_required` when an endpoint fell behind retention. Signed with the
notification webhooks' scheme. The delivery body is published in the spec's OpenAPI 3.1 `webhooks`
section as `DirectoryWebhookDelivery`.

Delivery is a sweep over the feed, every two minutes on both facades (the Worker's frequent cron
and a Node timer), rather than an emission inside each writer: the feed already orders every write,
so one reader replaces instrumenting every service that touches the directory. A sweeper takes a
per-endpoint lease (a token plus an expiry) before a push and moves `delivered_seq` only after the
push succeeds, so two sweepers never push overlapping pages, pages arrive in feed order, a failure
is retried, and a page whose sweeper died is sent again once the lease expires. Management stays on the deployment:
a mothership-mode node wires none of it, because the role-blind machine token may not reach
account-admin configuration.

### Node package `@cat-factory/directory-sync`

Hand-written, modelled on `sdk/gatekeeper-worker`. Signature verification moves out of
gatekeeper-worker into a shared `@cat-factory/webhooks` package both depend on.

- `verifyDelivery(headers, rawBody, secret)`: constant-time, Web Crypto, workerd-safe.
- `DirectorySyncer` over a `DirectoryStore` adapter the integrator implements (get and save the
  cursor, upsert or delete an entity with its `seq`, list local keys for reconciliation).
- `handleDelivery(headers, rawBody)`, `catchUp()` (feed pull from the stored cursor) and
  `reconcile()` (snapshot, diff, delete what is absent, replay from `asOfSeq`). `catchUp()` falls
  back to `reconcile()` on `cursor_expired`.

## Checklist

- [x] **Slice 1: change feed recording** ([#2307](https://github.com/kibertoad/cat-factory/pull/2307)). `directory_changes` table (D1
      0107, Drizzle), the `DirectoryChangeRepository` read port, appends inside every user, account
      membership, workspace, workspace membership and repo projection writer on both runtimes (the
      local CLI `linkRepo` now writes through the repository), `defineDirectoryFeedSuite`.
      The read repository is not in `CoreRepositories` yet because nothing consumes it: slice 3
      adds it there with mothership bucket `remote`.
- [x] **Slice 2: account-level API keys with a workspace subset** ([#2308](https://github.com/kibertoad/cat-factory/pull/2308);
      website: [cat-factory-website#100](https://github.com/kibertoad/cat-factory-website/pull/100)).
      `public_api_key_workspaces` grants plus `all_workspaces` (D1 0108, Drizzle), per-request
      workspace resolution in `authorize`, `workspaceIds` on the key and `/me`, the reach picker in
      the token panel, a workspace option on the four SDK clients, `definePublicKeyReachSuite`.
- [x] **Slice 3: public directory read API** ([#2309](https://github.com/kibertoad/cat-factory/pull/2309); website: [cat-factory-website#101](https://github.com/kibertoad/cat-factory-website/pull/101)). `DirectoryRepository`
      (feed reads, keyset snapshots, batched hydration, prune) on both runtimes and in the
      mothership allow-list, `DirectoryService`, `/api/v1/directory/*`,
      `DIRECTORY_CHANGE_RETENTION_DAYS` on both sweeps, OpenAPI 1.80.0,
      `definePublicDirectorySuite`.
- [x] **Slice 4: `directory.*` webhooks** ([#2310](https://github.com/kibertoad/cat-factory/pull/2310); website: [cat-factory-website#102](https://github.com/kibertoad/cat-factory-website/pull/102)). `directory_webhooks`
      (D1 0109, Drizzle), `DirectoryWebhookService` (management plus the claimed delivery sweep),
      `/api/v1/directory/webhooks`, the sweep on the Worker cron and a Node timer,
      `DirectoryWebhookDelivery` in the spec's `webhooks` section, `defineDirectoryWebhookSuite`.
- [ ] **Slice 5: `@cat-factory/webhooks` and `@cat-factory/directory-sync`.** Extract verification
      from gatekeeper-worker, ship the syncer with an in-memory store example.
- [ ] Convert this tracker to an ADR.

## Gotchas

- **Commit order must equal `seq` order.** A global sequence or a `MAX(seq) + 1` without the
  per-account lock hands out numbers in one order and commits them in another, and a reader skips
  the late one forever. Any new appender takes the lock (Postgres) or rides the writer's batch (D1).
- **Never prune an account's newest change row.** It is what `MAX(seq)` continues from.
- **A restricted key's grants are trusted without an ownership read.** They are checked against the
  account at mint, and a board is only ever linked to an account once (accountless to account),
  never moved. If boards ever become movable between accounts, `resolveWorkspace` must read the
  owner for restricted keys too, not only for unrestricted ones.
- **A cascade deletes rows no repository method sees.** Workspace deletion removes members and
  repos through `WORKSPACE_SCOPED_TABLES`; its batch appends their changes before the deletes.
  A new cascade path touching these tables needs the same treatment.
