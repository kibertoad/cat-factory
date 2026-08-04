import { bigint, index, pgSchema, text } from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// The AUDIT schema: the account audit log, and nothing else.
//
// It sits in its own Postgres schema (the Node analogue of the Cloudflare facade's separate
// `AUDIT_DB` D1 database) for a reason that is neither of the two that usually motivate a split.
// It is NOT the telemetry reason: audit is low-volume (admin actions, single digits per account
// per month, against telemetry's row per model CALL). And it is not blast-radius isolation:
// `db-reset.mjs` drops every app-owned schema together on purpose, this one included, so that no
// ledger can outlive its data.
//
// The reason is RETENTION, and the shape it forces on the store. Once the run-lifecycle slice
// lands, this is the only table in the platform that grows monotonically with run volume AND
// wants a multi-year window. Everything else is one or the other: `token_usage` grows with runs
// but prunes at ~395 days; the telemetry sinks grow far faster but prune at 3. That combination
// is what makes the log a capacity question on a store with a hard per-database ceiling (D1's
// 10 GB), and the separate store is what stops a years-deep audit trail from competing with live
// transactional state for that budget. Measured at ~508 B/row on Postgres (264 heap + 244 index,
// the index costing as much as the data because the keyset carries `id` as its tie-break), so
// 1,000 runs/day is roughly 550 MB/year.
//
// The second thing separation buys is governance: audit retention cannot be swept by a knob named
// for something else, because nothing else lives here to share one.
// ---------------------------------------------------------------------------

export const audit = pgSchema('audit')

// The account audit log: an append-only record of who did what, when, for the privileged and
// destructive actions an account admin is answerable for. Nothing in the platform UPDATEs or
// DELETEs a row here (the retention sweep is a later slice and is the only writer that ever
// will) — append-only is what makes the log worth reading.
//
// `actor_kind` + the two nullable actor columns are a discriminated principal rather than a
// nullable user id: `system` (the engine acted) and an unresolved user are different facts, and a
// log rendering them identically misattributes a human action to automation.
//
// There are deliberately NO foreign keys to `users` / `workspaces`, unlike the tenancy tables an
// audit row references. Two reasons, and the first is decisive: a schema-crossing FK would make
// an audit row deletable by a cascade somewhere else, and a log that a later delete can rewrite
// is not an audit log. The second is that the referenced principal may legitimately be gone (a
// removed user is exactly the kind of thing worth having a record of) — the row keeps the id and
// slice 4's viewer enriches what it can still resolve.
// Mirrors the D1 `audit_events` table (audit-migrations/0001_audit_events.sql); keep in step.
export const auditEvents = audit.table(
  'audit_events',
  {
    id: text('id').primaryKey(),
    account_id: text('account_id').notNull(),
    workspace_id: text('workspace_id'),
    actor_kind: text('actor_kind').notNull(),
    actor_user_id: text('actor_user_id'),
    actor_api_key_id: text('actor_api_key_id'),
    action: text('action').notNull(),
    target_type: text('target_type').notNull(),
    target_id: text('target_id').notNull(),
    summary: text('summary').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
  },
  // The viewer's ONLY read is one account's newest-first page. `id` breaks the `at` tie so two
  // events recorded in the same millisecond cannot straddle a page boundary and be served twice
  // or skipped.
  (t) => [index('idx_audit_events_account_at').on(t.account_id, t.at.desc(), t.id.desc())],
)
