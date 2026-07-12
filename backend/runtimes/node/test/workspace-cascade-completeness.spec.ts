import { describe, expect, it } from 'vitest'
import { is } from 'drizzle-orm'
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core'
import { WORKSPACE_CASCADE_SPECIAL_TABLES, WORKSPACE_SCOPED_TABLES } from '@cat-factory/kernel'
import * as schema from '../src/db/schema.js'

// The workspace-delete cascade is driven by the shared kernel list WORKSPACE_SCOPED_TABLES
// (see backend/packages/kernel/.../workspace-cascade.ts). This guard makes a NEW workspace-scoped
// table impossible to forget: every Drizzle table that carries a `workspace_id` column must be
// either in that list or acknowledged as a deliberately-special case — otherwise a board delete
// would orphan its rows forever, which is exactly the bug this list exists to prevent.
describe('workspace-delete cascade completeness (Node/Drizzle schema)', () => {
  // Introspect the schema module: every exported pgTable in the PRIMARY (public/default) schema
  // that has a `workspace_id` column. The workspace-delete cascade runs on the main DB connection
  // and only reaches the default-schema tables. Tables in the isolated `telemetry` / `sandbox` /
  // `provisioning` schemas are DELIBERATELY out of scope: on the Worker facade telemetry lives in a
  // physically separate D1 database, and on Node those schemas are append-heavy / short-retention
  // stores reclaimed by their own retention sweeps (e.g. `llm_call_metrics`) or the extractable
  // sandbox surface — never by the board-delete cascade. Filtering on `schema === undefined` keeps
  // this guard focused on exactly the tables the cascade is responsible for.
  const workspaceScopedTables = (Object.values(schema) as unknown[])
    .filter((v) => is(v, PgTable))
    .map((v) => getTableConfig(v as PgTable))
    .filter((cfg) => cfg.schema === undefined)
    .filter((cfg) => cfg.columns.some((c) => c.name === 'workspace_id'))
    .map((cfg) => cfg.name)
    .sort()

  const covered = new Set<string>([...WORKSPACE_SCOPED_TABLES, ...WORKSPACE_CASCADE_SPECIAL_TABLES])

  it('every workspace-scoped table is either cascaded or a known special case', () => {
    const uncovered = workspaceScopedTables.filter((t) => !covered.has(t))
    // If this fails, a new table with a `workspace_id` column was added without wiring it into
    // the workspace-delete cascade. Add it to WORKSPACE_SCOPED_TABLES (plain reclaim) or to
    // WORKSPACE_CASCADE_SPECIAL_TABLES with a comment saying why it is handled specially.
    expect(uncovered).toEqual([])
  })

  it('the cascade list contains no stale entries (every listed table still exists in the schema)', () => {
    const existing = new Set(workspaceScopedTables)
    const stale = WORKSPACE_SCOPED_TABLES.filter((t) => !existing.has(t))
    expect(stale).toEqual([])
  })

  it('the list and the special set are disjoint', () => {
    const overlap = WORKSPACE_SCOPED_TABLES.filter((t) =>
      (WORKSPACE_CASCADE_SPECIAL_TABLES as readonly string[]).includes(t),
    )
    expect(overlap).toEqual([])
  })
})
