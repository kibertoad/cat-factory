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
      // The sweeper read pairs each executing initiative with its owning workspace (the entity
      // itself carries no workspace id), so the execution loop can tick the right workspace.
      const hit = due.find((r) => r.initiative.id === a.id)
      expect(hit?.workspaceId).toBe(a.ws)
      expect(due.some((r) => r.initiative.id === b.id)).toBe(false)
    })

    it('round-trips the execution-loop item state through the CAS (spawn/reconcile/block)', async () => {
      // The loop's per-item runtime state (a spawned block link, a settled PR, a blocked item
      // + its deviation, and the paused lifecycle) must persist byte-identically on both stores,
      // since the loop reads it back every tick to decide what to reconcile / spawn next.
      const { initiatives } = makeRepos()
      const { ws, block, id } = ids()
      await initiatives.insert(ws, initiative({ id, blockId: block, slug: 'loop-state' }))

      const advanced: Initiative = {
        ...initiative({ id, blockId: block, slug: 'loop-state' }),
        status: 'paused',
        items: [
          {
            id: 'item-1',
            phaseId: 'phase-1',
            title: 'Convert the gate registry',
            description: 'Move registerGate to app-owned DI.',
            dependsOn: [],
            estimate: { complexity: 0.4, risk: 0.2, impact: 0.6, rationale: 'contained' },
            status: 'pr_open',
            blockId: `${block}-task-1`,
            pr: { url: 'https://github.com/o/r/pull/7', number: 7 },
          },
          {
            id: 'item-2',
            phaseId: 'phase-1',
            title: 'Convert the model-provider registry',
            description: 'Second registry.',
            dependsOn: ['item-1'],
            status: 'blocked',
            blockId: `${block}-task-2`,
            note: 'The spawned task failed.',
          },
        ],
        deviations: [
          { id: 'idev-1', at: 5, itemId: 'item-2', description: 'Task blocked; phase halted.' },
        ],
        rev: 1,
        updatedAt: 2,
      }
      expect(await initiatives.compareAndSwap(ws, advanced, 0)).toBe(true)

      const read = await initiatives.get(ws, id)
      expect(read).toEqual(advanced)
    })

    it('round-trips harvested follow-ups + a promoted item through the CAS (slice 4)', async () => {
      // Slice 4's curation state — an open harvested follow-up, one promoted into a real item
      // (status `promoted` + `promotedItemId` back-reference), and the new item it produced —
      // rides the entity's `doc` blob, so both stores must (de)serialise the nested arrays intact.
      const { initiatives } = makeRepos()
      const { ws, block, id } = ids()
      await initiatives.insert(ws, initiative({ id, blockId: block, slug: 'curation' }))
      const curated: Initiative = {
        ...initiative({ id, blockId: block, slug: 'curation' }),
        status: 'executing',
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
          {
            id: 'item-promoted',
            phaseId: 'phase-1',
            title: 'Extract the shared helper',
            description: 'promoted from a follow-up',
            dependsOn: [],
            status: 'pending',
          },
        ],
        followUps: [
          {
            id: 'ifu-child-fu-1',
            at: 6,
            sourceItemId: 'item-1',
            title: 'Extract the shared helper',
            detail: 'the parser is duplicated',
            status: 'promoted',
            promotedItemId: 'item-promoted',
          },
          {
            id: 'ifu-open',
            at: 7,
            sourceItemId: null,
            title: 'Add a metric',
            detail: '',
            status: 'open',
          },
        ],
        rev: 1,
        updatedAt: 2,
      }
      expect(await initiatives.compareAndSwap(ws, curated, 0)).toBe(true)

      const read = await initiatives.get(ws, id)
      expect(read).toEqual(curated)
      expect(read!.followUps!.find((f) => f.id === 'ifu-child-fu-1')).toMatchObject({
        status: 'promoted',
        promotedItemId: 'item-promoted',
      })
    })

    it('round-trips a preset-authored item spawn bag through the CAS (slice 5)', async () => {
      // The spawn decoration (`item.spawn`: the typed-task `taskTypeFields`, best-practice
      // `fragmentIds`, per-agent `agentConfig`, and the per-run gate override) rides the entity's
      // `doc` blob, so both stores must (de)serialise the nested bag intact — it's exactly what the
      // loop's `buildTaskBlock` folds onto the spawned task block, so a store that dropped it would
      // silently spawn a bare description block instead of a first-class doc task.
      const { initiatives } = makeRepos()
      const { ws, block, id } = ids()
      await initiatives.insert(ws, initiative({ id, blockId: block, slug: 'spawn-decoration' }))
      const decorated: Initiative = {
        ...initiative({ id, blockId: block, slug: 'spawn-decoration' }),
        status: 'executing',
        items: [
          {
            id: 'item-1',
            phaseId: 'phase-1',
            title: 'Refresh the API reference',
            description: 'Document the public API surface.',
            dependsOn: [],
            status: 'pending',
            spawn: {
              taskTypeFields: { docKind: 'reference', targetPath: 'docs/api/reference.md' },
              fragmentIds: ['style.anti-llmisms', 'style.concise-actionable'],
              agentConfig: { 'tester.environment': 'local' },
              gates: [true, false, false],
            },
          },
        ],
        rev: 1,
        updatedAt: 2,
      }
      expect(await initiatives.compareAndSwap(ws, decorated, 0)).toBe(true)

      const read = await initiatives.get(ws, id)
      expect(read).toEqual(decorated)
      expect(read!.items![0]!.spawn).toEqual(decorated.items![0]!.spawn)
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
