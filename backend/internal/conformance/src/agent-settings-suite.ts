import type { WorkspaceAgentSettings, WorkspaceAgentSettingsRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the per-workspace, per-agent-kind generation-settings store — the
// output-token ceilings behind the pipeline builder's budget control (D1 on Cloudflare,
// Drizzle/Postgres on Node).
//
// The behaviours asserted here are the ones a single store could get wrong invisibly:
//
//  - `upsert` must REPLACE, not accumulate. This store is the deliberate opposite of the prompt
//    log next door: its primary-key conflict resolves to an update. A store that inserted
//    instead would either error on every re-save or (worse, on a store without the constraint)
//    leave two rows for one kind, and `get` would then answer whichever the planner returned.
//  - `maxOutputTokens` must ROUND-TRIP as a NUMBER, not a string. Both stores keep it in an
//    INTEGER column, but a driver that hands back a string would make the engine pass `"24000"`
//    to the AI SDK — which is not a type error anywhere in the chain, just a silently ignored
//    or NaN-coerced ceiling.
//  - `remove` must be the ONLY way a kind reads as inheriting. The service deletes the row when
//    nothing is left configured, so `get` returning null is what "inherit the deployment
//    default" means; a store whose delete silently missed would keep applying a stale ceiling.
//  - Rows must be WORKSPACE-SCOPED. Both stores key on a composite primary key whose first
//    column is the workspace, so a query that forgot the workspace predicate would leak one
//    tenant's ceilings into another's — and with `list` ordering by kind, would look plausible.

function settings(overrides: Partial<WorkspaceAgentSettings> = {}): WorkspaceAgentSettings {
  return {
    agentKind: 'doc-researcher',
    maxOutputTokens: 24_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link WorkspaceAgentSettingsRepository} behaves identically to the others.
 * `makeRepo` returns a repository over the runtime's real store; ids are unique per run so the
 * shared database stays isolated.
 */
export function defineAgentSettingsSuite(
  name: string,
  makeRepo: () => WorkspaceAgentSettingsRepository,
): void {
  describe(`[${name}] workspace agent settings repository parity`, () => {
    let seq = 0
    const nextWs = () => {
      seq += 1
      return `ws-as-${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    it('round-trips a row, keeping the ceiling a number', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      const entity = settings()
      await repo.upsert(ws, entity)

      expect(await repo.get(ws, 'doc-researcher')).toEqual(entity)
      // Explicit: `toEqual` would pass on a numeric string in neither direction, but the point of
      // the assertion is the TYPE the driver hands back, so it is stated rather than implied.
      expect(typeof (await repo.get(ws, 'doc-researcher'))?.maxOutputTokens).toBe('number')
    })

    it('returns null for a kind the workspace never configured', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      await repo.upsert(ws, settings())

      expect(await repo.get(ws, 'coder')).toBeNull()
    })

    it('replaces on re-upsert rather than accumulating a second row', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      await repo.upsert(ws, settings({ maxOutputTokens: 10_000 }))
      await repo.upsert(ws, settings({ maxOutputTokens: 32_000, updatedAt: 1_700_000_001_000 }))

      expect(await repo.get(ws, 'doc-researcher')).toEqual(
        settings({ maxOutputTokens: 32_000, updatedAt: 1_700_000_001_000 }),
      )
      // The whole point: one kind, one row. A store that inserted would return two here.
      expect(await repo.list(ws)).toHaveLength(1)
    })

    it('round-trips an explicit null ceiling', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      // The service normally deletes rather than storing this, but the COLUMN is nullable and a
      // store that coerced null to 0 would hand the engine a zero-token ceiling — every reply
      // empty — instead of falling through to the deployment default.
      await repo.upsert(ws, settings({ maxOutputTokens: null }))

      expect(await repo.get(ws, 'doc-researcher')).toEqual(settings({ maxOutputTokens: null }))
    })

    it('lists every configured kind for the workspace, ordered by kind', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      await repo.upsert(ws, settings({ agentKind: 'doc-researcher' }))
      await repo.upsert(ws, settings({ agentKind: 'coder', maxOutputTokens: 8_000 }))

      expect((await repo.list(ws)).map((s) => s.agentKind)).toEqual(['coder', 'doc-researcher'])
    })

    it('removes a row so the kind reads as inheriting again', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      await repo.upsert(ws, settings())
      await repo.remove(ws, 'doc-researcher')

      expect(await repo.get(ws, 'doc-researcher')).toBeNull()
      expect(await repo.list(ws)).toEqual([])
    })

    it('treats removing an unconfigured kind as a no-op', async () => {
      const repo = makeRepo()
      const ws = nextWs()
      await repo.upsert(ws, settings())

      await repo.remove(ws, 'coder')

      expect(await repo.get(ws, 'doc-researcher')).toEqual(settings())
    })

    it('scopes rows to their workspace', async () => {
      const repo = makeRepo()
      const a = nextWs()
      const b = nextWs()
      await repo.upsert(a, settings({ maxOutputTokens: 24_000 }))
      await repo.upsert(b, settings({ maxOutputTokens: 8_000 }))

      expect((await repo.get(a, 'doc-researcher'))?.maxOutputTokens).toBe(24_000)
      expect((await repo.get(b, 'doc-researcher'))?.maxOutputTokens).toBe(8_000)
      // And a delete in one workspace must not reach the other's row for the same kind.
      await repo.remove(a, 'doc-researcher')
      expect(await repo.get(b, 'doc-researcher')).not.toBeNull()
    })
  })
}
