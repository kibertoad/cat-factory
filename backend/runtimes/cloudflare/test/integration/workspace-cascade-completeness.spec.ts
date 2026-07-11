import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { WORKSPACE_CASCADE_SPECIAL_TABLES, WORKSPACE_SCOPED_TABLES } from '@cat-factory/kernel'
import { D1_ONLY_WORKSPACE_SCOPED_TABLES } from '../../src/infrastructure/repositories/D1WorkspaceRepository'

// D1-side twin of node/test/workspace-cascade-completeness.spec.ts. The Node/Drizzle guard
// introspects the Postgres schema, so it CANNOT see Cloudflare-only tables (the Durable-Object
// `live_containers` tracking table) — a new D1-only `workspace_id` table could therefore slip
// the cascade with no failing Node test. This guard closes that gap by introspecting the REAL
// migrated local D1 (`env.DB`): every table with a `workspace_id` column must be in the shared
// kernel list, an acknowledged special case, or the facade's D1-only list — otherwise a board
// delete would orphan its rows forever, exactly the bug the cascade exists to prevent.
//
// The isolated telemetry / sandbox / provisioning stores are PHYSICALLY SEPARATE D1 databases on
// this facade (env.TELEMETRY_DB / env.SANDBOX_DB / env.PROVISIONING_DB), not tables in env.DB, so
// introspecting env.DB alone naturally scopes this to exactly the tables the cascade owns — the
// D1 analogue of the Node guard's `schema === undefined` filter, for free.
describe('workspace-delete cascade completeness (Cloudflare/D1 schema)', () => {
  async function workspaceScopedTables(): Promise<string[]> {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
    ).all<{ name: string }>()
    const scoped: string[] = []
    for (const { name } of tables.results) {
      // Table names come from sqlite_master (the DB's own catalog), not user input, and PRAGMA
      // does not accept bound parameters — safe to interpolate.
      const cols = await env.DB.prepare(`PRAGMA table_info(${name})`).all<{ name: string }>()
      if (cols.results.some((c) => c.name === 'workspace_id')) scoped.push(name)
    }
    return scoped.sort()
  }

  const covered = new Set<string>([
    ...WORKSPACE_SCOPED_TABLES,
    ...WORKSPACE_CASCADE_SPECIAL_TABLES,
    ...D1_ONLY_WORKSPACE_SCOPED_TABLES,
  ])

  it('every workspace-scoped D1 table is either cascaded, a known special case, or D1-only', async () => {
    const uncovered = (await workspaceScopedTables()).filter((t) => !covered.has(t))
    // If this fails, a table with a `workspace_id` column exists in the D1 schema without being
    // wired into the workspace-delete cascade. Add it to WORKSPACE_SCOPED_TABLES (shared reclaim),
    // WORKSPACE_CASCADE_SPECIAL_TABLES (bespoke handling), or D1_ONLY_WORKSPACE_SCOPED_TABLES
    // (Cloudflare-only, no Node analogue) with a comment saying why.
    expect(uncovered).toEqual([])
  })

  it('the cascade lists contain no stale entries (every listed D1 table still exists)', async () => {
    const existing = new Set(await workspaceScopedTables())
    const stale = [...WORKSPACE_SCOPED_TABLES, ...D1_ONLY_WORKSPACE_SCOPED_TABLES].filter(
      (t) => !existing.has(t),
    )
    // WORKSPACE_CASCADE_SPECIAL_TABLES is intentionally excluded: `binary_artifacts` carries a
    // workspace_id and exists, while `workspace_services` is the mount join — both are asserted by
    // the Node schema guard. Here we only guard tables the D1 delete actually issues `DELETE`s for.
    expect(stale).toEqual([])
  })
})
