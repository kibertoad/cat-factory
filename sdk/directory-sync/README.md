# @cat-factory/directory-sync

Keep a copy of a cat-factory account's directory in your own system: its workspaces, users,
account memberships, workspace memberships and linked repositories. You implement storage; the
syncer drives the snapshots, the change feed, webhook pushes and reconciliation.

```ts
import { CatFactoryClient } from '@cat-factory/sdk'
import { DirectorySyncer } from '@cat-factory/directory-sync'

const syncer = new DirectorySyncer({
  // An account-wide `read` key mirrors everything. A key limited to some workspaces mirrors their
  // workspaces, memberships and repositories, and skips users and account memberships.
  client: new CatFactoryClient({ baseUrl, apiKey }),
  store: myStore, // implements DirectoryStore
  webhookSecret: process.env.DIRECTORY_WEBHOOK_SECRET, // only if you register a webhook
})

await syncer.catchUp() // on startup: bootstraps from the snapshots the first time
// Both reject on a network or API failure. Catch it: an unhandled rejection ends a Node process,
// and the next tick resumes from the stored cursor anyway.
setInterval(() => syncer.catchUp().catch(reportError), 5 * 60_000) // the completeness backstop
setInterval(() => syncer.reconcile().catch(reportError), 24 * 60 * 60_000) // a daily drift check

// Optional: a directory webhook for changes within a couple of minutes.
app.post('/cat-factory/directory', (request) => syncer.handleRequest(request))
```

## Implementing `DirectoryStore`

```ts
interface DirectoryStore {
  getCursor(): Promise<number | null>
  setCursor(seq: number): Promise<void>
  apply(record: DirectoryRecord): Promise<void>
  listKeys(entityType: DirectoryEntityType): Promise<string[]>
}
```

Every record names an entity (`entityType` plus a stable `key`), carries the feed position it is
current as of (`seq`), and its state, or `null` when the entity is gone. **One rule makes the store
correct: skip a record only when you already hold a strictly newer `seq` for that key, and keep
deletions as tombstones with their `seq`.** With that, pushes and polls may arrive in any order and
any number of times. In SQL that is one conditional upsert per record:

```sql
INSERT INTO directory_entities (entity_type, key, seq, entity)
VALUES ($1, $2, $3, $4)
ON CONFLICT (entity_type, key) DO UPDATE
  SET seq = excluded.seq, entity = excluded.entity
  WHERE directory_entities.seq <= excluded.seq
```

`MemoryDirectoryStore` is a complete reference implementation.

## How it stays correct

- `catchUp()` follows `GET /api/v1/directory/changes` from your cursor. Each change carries the
  entity's current state, so applying them in order converges however late you read them.
- With no cursor, or one older than the feed keeps (`409 cursor_expired`), it reconciles instead.
- `reconcile()` walks every snapshot, writes what it finds, deletes what you hold that the source
  no longer does, then replays the feed from the earliest snapshot position, so anything that
  changed during the walk is picked up.
- `handleDelivery()` verifies the push signature before parsing, applies the page, then catches up
  from your cursor, so a lost or reordered push costs only latency.
- A workspace deletion also deletes the memberships and repositories held under it. A key limited
  to some workspaces is told the workspace is gone but never sees those rows' own deletions.
- A webhook endpoint is account-level, so its pushes carry the whole account. Before applying a
  push the syncer reads its key's reach (`GET /api/v1/me`) and keeps only what that key could read
  from the feed itself, so a restricted key's store never holds users or boards it cannot see.
- Calls on one syncer never interleave. Run one syncer per store.
