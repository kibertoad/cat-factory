import type { Block, BlockRepository, Initiative, InitiativeRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the initiative store (the long-running multi-task work
// container). The InitiativeService and the planning-pipeline steps are runtime-neutral,
// but each facade persists the entity in its own store — D1 on Cloudflare,
// Drizzle/Postgres on Node. This suite drives the SAME insert → read → CAS → delete
// assertions through whichever real repositories a runtime hands it, so a column mapped
// differently, a doc blob (de)serialised differently, or a CAS predicate that doesn't
// actually guard on `rev` fails a test instead of shipping. It also pins the
// `blocks.initiative_id` membership column both block repos must round-trip.

function initiative(
  overrides: Partial<Initiative> & Pick<Initiative, 'id' | 'blockId' | 'slug'>,
): Initiative {
  return {
    title: 'Registry DI migration',
    goal: 'Move module-global registries to app-owned DI',
    constraints: ['keep the runtimes symmetric'],
    nonGoals: ['backwards compatibility'],
    qa: [{ id: 'iqa-1', question: 'Scope?', answer: 'All registries' }],
    interview: { round: 1, maxRounds: 4, status: 'done' },
    analysisSummary: 'Registries live in kernel/agents.',
    phases: [{ id: 'phase-1', title: 'Pilot', goal: 'Convert one registry' }],
    items: [
      {
        id: 'item-1',
        phaseId: 'phase-1',
        title: 'Convert the gate registry',
        description: 'Move registerGate to app-owned DI.',
        dependsOn: [],
        estimate: { complexity: 0.4, risk: 0.2, impact: 0.6, rationale: 'contained' },
        status: 'pending',
      },
    ],
    policy: {
      maxConcurrent: 2,
      rules: [{ pipelineId: 'pl_quick', minComplexity: 0 }],
      defaultPipelineId: 'pl_full',
      onMissingEstimate: 'default',
    },
    decisions: [
      { id: 'dec-1', at: 1, title: 'One registry per PR', detail: '', source: 'planning' },
    ],
    deviations: [],
    followUps: [],
    caveats: ['watch the conformance suite'],
    status: 'planning',
    rev: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link InitiativeRepository} (+ its block repo's `initiativeId`
 * mapping) behaves identically to the others. `makeRepos` returns repos over the
 * runtime's real store; ids are unique per run so the shared database stays isolated.
 */
export function defineInitiativeSuite(
  name: string,
  makeRepos: () => { initiatives: InitiativeRepository; blocks: BlockRepository },
): void {
  describe(`[${name}] initiative repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, block: `blk-${tag}`, id: `initv-${tag}` }
    }

    it('round-trips an entity by id and by block, preserving the full doc', async () => {
      const { initiatives } = makeRepos()
      const { ws, block, id } = ids()
      const entity = initiative({ id, blockId: block, slug: 'registry-di-migration' })
      await initiatives.insert(ws, entity)

      const byId = await initiatives.get(ws, id)
      expect(byId).toEqual(entity)

      const byBlock = await initiatives.getByBlock(ws, block)
      expect(byBlock).toEqual(entity)

      const listed = await initiatives.list(ws)
      expect(listed).toEqual([entity])
    })

    it('CAS write persists only when the expected rev matches (stale writer loses)', async () => {
      const { initiatives } = makeRepos()
      const { ws, block, id } = ids()
      const entity = initiative({ id, blockId: block, slug: 'cas' })
      await initiatives.insert(ws, entity)

      const winner: Initiative = {
        ...entity,
        status: 'executing',
        rev: 1,
        updatedAt: 2,
        doc: { version: 1, hash: 'abc', committedAt: 2 },
      }
      expect(await initiatives.compareAndSwap(ws, winner, 0)).toBe(true)

      // A concurrent writer that read rev 0 must LOSE and change nothing.
      const stale: Initiative = { ...entity, status: 'cancelled', rev: 1, updatedAt: 3 }
      expect(await initiatives.compareAndSwap(ws, stale, 0)).toBe(false)

      const current = await initiatives.get(ws, id)
      expect(current!.status).toBe('executing')
      expect(current!.rev).toBe(1)
      expect(current!.doc).toEqual({ version: 1, hash: 'abc', committedAt: 2 })
    })

    it('lists executing initiatives across workspaces (the sweeper read)', async () => {
      const { initiatives } = makeRepos()
      const a = ids()
      const b = ids()
      const executing = initiative({
        id: a.id,
        blockId: a.block,
        slug: 'executing',
        status: 'executing',
      })
      const planning = initiative({ id: b.id, blockId: b.block, slug: 'planning' })
      await initiatives.insert(a.ws, executing)
      await initiatives.insert(b.ws, planning)

      const due = await initiatives.listExecuting()
      expect(due.some((i) => i.id === a.id)).toBe(true)
      expect(due.some((i) => i.id === b.id)).toBe(false)
    })

    it('delete removes the entity', async () => {
      const { initiatives } = makeRepos()
      const { ws, block, id } = ids()
      await initiatives.insert(ws, initiative({ id, blockId: block, slug: 'gone' }))
      await initiatives.delete(ws, id)
      expect(await initiatives.get(ws, id)).toBeNull()
      expect(await initiatives.list(ws)).toEqual([])
    })

    it("round-trips a block-level initiative + a task's initiativeId membership link", async () => {
      const { blocks } = makeRepos()
      const { ws, block } = ids()
      const initiativeBlock: Block = {
        id: block,
        title: 'Initiative block',
        type: 'service',
        description: '',
        position: { x: 0, y: 0 },
        status: 'planned',
        progress: 0,
        dependsOn: [],
        executionId: null,
        level: 'initiative',
        parentId: null,
      }
      const task: Block = {
        ...initiativeBlock,
        id: `${block}-task`,
        title: 'Spawned task',
        level: 'task',
        initiativeId: block,
      }
      await blocks.insert(ws, initiativeBlock)
      await blocks.insert(ws, task)

      const storedInitiative = await blocks.get(ws, block)
      expect(storedInitiative!.level).toBe('initiative')
      const storedTask = await blocks.get(ws, task.id)
      expect(storedTask!.initiativeId).toBe(block)

      // Detach: an empty patch value clears the membership link.
      await blocks.update(ws, task.id, { initiativeId: null })
      const detached = await blocks.get(ws, task.id)
      expect(detached!.initiativeId ?? null).toBeNull()
    })
  })
}
