import type { ConsensusGroup, ConsensusGroupRepository } from '@cat-factory/kernel'
import { selectConsensusGroup } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the workspace CONSENSUS-GROUP library — the reusable,
// estimate-gated panels a pipeline step escalates to. Two JSON columns carry load-bearing
// meaning here (`participants`, and `gating`, which is what the tier selection reads), and the
// optional scalars (`description`, `synthesizerModelId`, `rounds`) must round-trip as ABSENT
// rather than as `null`, since the domain shape treats a present-but-null field differently from
// a missing one. A store that drops or coerces any of them fails a test instead of quietly
// downgrading a workspace's reviews to a lower tier — a failure that would otherwise show up only
// as "why did the cheap panel run on our riskiest task".

function participant(id: string, role: string, modelId?: string) {
  return { id, role, ...(modelId ? { modelId } : {}) }
}

function group(overrides: Partial<ConsensusGroup> & Pick<ConsensusGroup, 'id'>): ConsensusGroup {
  return {
    name: 'Deep review panel',
    description: 'Three models, independent, neutral synthesis.',
    strategy: 'specialist-panel',
    participants: [
      participant('p1', 'Pragmatist', 'kimi-k2.7'),
      participant('p2', 'Security reviewer', 'claude-opus-5'),
      participant('p3', 'Skeptic'),
    ],
    synthesizerModelId: 'claude-opus-5',
    rounds: 3,
    gating: { enabled: true, minRisk: 0.7, minImpact: 0.8, onMissingEstimate: 'consensus' },
    createdAt: 1,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link ConsensusGroupRepository} behaves identically to the others.
 * `makeRepo` returns a repository over the runtime's real store; ids are unique per run so the
 * shared database stays isolated.
 */
export function defineConsensusGroupSuite(
  name: string,
  makeRepo: () => ConsensusGroupRepository,
): void {
  describe(`[${name}] consensus group repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, id: `cng-${tag}` }
    }

    it('round-trips a full group by id and by list, preserving participants + the gating bar', async () => {
      const repo = makeRepo()
      const { ws, id } = ids()
      const entity = group({ id })
      await repo.upsert(ws, entity)

      expect(await repo.get(ws, id)).toEqual(entity)
      expect(await repo.list(ws)).toEqual([entity])
    })

    it('round-trips the minimal shape — the optional scalars stay ABSENT, not null', async () => {
      const repo = makeRepo()
      const { ws, id } = ids()
      const minimal: ConsensusGroup = {
        id,
        name: 'Duo',
        strategy: 'debate',
        participants: [participant('p1', 'A'), participant('p2', 'B')],
        gating: { enabled: false, onMissingEstimate: 'consensus' },
        createdAt: 5,
      }
      await repo.upsert(ws, minimal)

      const read = await repo.get(ws, id)
      expect(read).toEqual(minimal)
      // `toEqual` ignores undefined-valued keys, so assert absence explicitly: a store that
      // materialised `description: null` would satisfy the check above but break the strategy
      // and rounds defaults that key off `!== undefined`.
      expect(read && 'description' in read).toBe(false)
      expect(read && 'rounds' in read).toBe(false)
      expect(read && 'synthesizerModelId' in read).toBe(false)
    })

    it('upsert overwrites in place — a re-tiered group keeps one row', async () => {
      const repo = makeRepo()
      const { ws, id } = ids()
      await repo.upsert(ws, group({ id }))

      const retiered = group({
        id,
        name: 'Deep review panel (raised)',
        gating: { enabled: true, minComplexity: 0.9, onMissingEstimate: 'standard' },
      })
      await repo.upsert(ws, retiered)

      expect(await repo.get(ws, id)).toEqual(retiered)
      expect(await repo.list(ws)).toHaveLength(1)
    })

    it('scopes reads to a workspace and lists in creation order', async () => {
      const repo = makeRepo()
      const a = ids()
      const b = ids()
      await repo.upsert(a.ws, group({ id: b.id, name: 'second', createdAt: 20 }))
      await repo.upsert(a.ws, group({ id: a.id, name: 'first', createdAt: 10 }))
      await repo.upsert(b.ws, group({ id: a.id, name: 'other workspace' }))

      expect((await repo.list(a.ws)).map((g) => g.name)).toEqual(['first', 'second'])
      expect(await repo.get(b.ws, b.id)).toBeNull()
    })

    it('listByIds batches the dispatch-path read and omits ids that no longer resolve', async () => {
      const repo = makeRepo()
      const { ws } = ids()
      const floor = group({ id: `${ws}-floor`, name: 'floor', createdAt: 1 })
      const top = group({ id: `${ws}-top`, name: 'top', createdAt: 2 })
      await repo.upsert(ws, floor)
      await repo.upsert(ws, top)

      const read = await repo.listByIds(ws, [floor.id, top.id, `${ws}-deleted`])
      expect(read.map((g) => g.name).sort()).toEqual(['floor', 'top'])
      // A step whose tier set names only deleted groups degrades to the standard agent rather
      // than erroring, which is what makes deleting a group safe without rewriting pipelines.
      expect(await repo.listByIds(ws, [`${ws}-deleted`])).toEqual([])
      expect(await repo.listByIds(ws, [])).toEqual([])
    })

    it('feeds the tier selection identically on every runtime', async () => {
      const repo = makeRepo()
      const { ws } = ids()
      const floor = group({
        id: `${ws}-a`,
        name: 'floor',
        gating: { enabled: false, onMissingEstimate: 'consensus' },
        createdAt: 1,
      })
      const top = group({
        id: `${ws}-b`,
        name: 'top',
        gating: { enabled: true, minRisk: 0.8, onMissingEstimate: 'consensus' },
        createdAt: 2,
      })
      await repo.upsert(ws, floor)
      await repo.upsert(ws, top)

      const candidates = await repo.listByIds(ws, [floor.id, top.id])
      const estimate = (risk: number) => ({
        complexity: 0.1,
        risk,
        impact: 0.1,
        rationale: '',
        createdAt: 1,
      })
      expect(selectConsensusGroup(candidates, estimate(0.9))?.name).toBe('top')
      expect(selectConsensusGroup(candidates, estimate(0.2))?.name).toBe('floor')
    })

    it('remove deletes the group and is a no-op for an unknown id', async () => {
      const repo = makeRepo()
      const { ws, id } = ids()
      await repo.upsert(ws, group({ id }))
      await repo.remove(ws, id)
      expect(await repo.get(ws, id)).toBeNull()
      await repo.remove(ws, `${id}-missing`)
    })
  })
}
