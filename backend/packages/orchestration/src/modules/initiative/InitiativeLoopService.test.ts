import type {
  Block,
  BlockRepository,
  Initiative,
  InitiativeItem,
  Pipeline,
  PipelineRepository,
} from '@cat-factory/kernel'
import { ConflictError, InitiativePresetRegistry, NoopEventPublisher } from '@cat-factory/kernel'
import { DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS } from '@cat-factory/prompt-fragments'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionService } from '../execution/ExecutionService.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import { InitiativeLoopService } from './InitiativeLoopService.js'
import { InitiativeService } from './InitiativeService.js'

// The execution loop driven over in-memory fakes: the InitiativeService's real CAS `mutate`
// spine plus hand-rolled block/pipeline stores, so the reconcile → complete → spawn behaviour
// is exercised end to end (the per-store persistence parity is covered by the conformance suite).

let clockNow = 1_000
const clock = { now: () => clockNow }
let idSeq = 0
const idGenerator = { next: (prefix: string) => `${prefix}-${++idSeq}` }

/** A tiny in-memory InitiativeRepository (workspace-scoped, rev-CAS). */
function makeInitiativeStore() {
  const rows = new Map<string, { workspaceId: string; entity: Initiative }>()
  const key = (ws: string, id: string) => `${ws}:${id}`
  return {
    get: async (ws: string, id: string) => rows.get(key(ws, id))?.entity ?? null,
    getByBlock: async (ws: string, blockId: string) =>
      [...rows.values()].find((r) => r.workspaceId === ws && r.entity.blockId === blockId)
        ?.entity ?? null,
    list: async (ws: string) =>
      [...rows.values()].filter((r) => r.workspaceId === ws).map((r) => r.entity),
    listExecuting: async () =>
      [...rows.values()]
        .filter((r) => r.entity.status === 'executing')
        .map((r) => ({ workspaceId: r.workspaceId, initiative: r.entity })),
    insert: async (ws: string, entity: Initiative) => {
      rows.set(key(ws, entity.id), { workspaceId: ws, entity })
    },
    compareAndSwap: async (ws: string, next: Initiative, expectedRev: number) => {
      const cur = rows.get(key(ws, next.id))
      if (!cur || cur.entity.rev !== expectedRev) return false
      rows.set(key(ws, next.id), { workspaceId: ws, entity: next })
      return true
    },
    delete: async (ws: string, id: string) => {
      rows.delete(key(ws, id))
    },
  }
}

/** A tiny in-memory block store — only the methods the loop touches. */
function makeBlockStore() {
  const rows = new Map<string, { ws: string; block: Block }>()
  const store = {
    listByWorkspace: async (ws: string) =>
      [...rows.values()].filter((r) => r.ws === ws).map((r) => r.block),
    findByIds: async (ids: string[]) =>
      ids
        .map((id) => rows.get(id))
        .filter((r): r is { ws: string; block: Block } => !!r)
        .map((r) => ({ workspaceId: r.ws, serviceId: null, block: r.block })),
    get: async (ws: string, id: string) => rows.get(id)?.block ?? null,
    insert: async (ws: string, block: Block) => {
      rows.set(block.id, { ws, block })
    },
    deleteMany: async (_ws: string, ids: string[]) => {
      for (const id of ids) rows.delete(id)
    },
    update: async (ws: string, id: string, patch: Partial<Block>) => {
      const cur = rows.get(id)
      if (cur) rows.set(id, { ws, block: { ...cur.block, ...patch } })
    },
  }
  return { store: store as unknown as BlockRepository, rows }
}

const pipeline = (id: string): Pipeline =>
  ({ id, name: id, agentKinds: ['coder'], workspaceId: 'ws-1' }) as unknown as Pipeline

function makePipelineStore(ids: string[]): PipelineRepository {
  const set = new Set(ids)
  return {
    get: async (_ws: string, id: string) => (set.has(id) ? pipeline(id) : null),
  } as unknown as PipelineRepository
}

const frame: Block = {
  id: 'frame-1',
  title: 'Service',
  type: 'service',
  description: '',
  position: { x: 0, y: 0 },
  status: 'ready',
  progress: 0,
  dependsOn: [],
  executionId: null,
  level: 'frame',
  parentId: null,
}

const initiativeBlock: Block = {
  ...frame,
  id: 'init-blk',
  title: 'Initiative',
  level: 'initiative',
  status: 'in_progress',
  parentId: frame.id,
}

const item = (overrides: Partial<InitiativeItem> & Pick<InitiativeItem, 'id'>): InitiativeItem => ({
  phaseId: 'p1',
  title: `Item ${overrides.id}`,
  description: `Do ${overrides.id}`,
  dependsOn: [],
  status: 'pending',
  ...overrides,
})

function makeInitiative(items: InitiativeItem[], overrides: Partial<Initiative> = {}): Initiative {
  return {
    id: 'initv-1',
    blockId: initiativeBlock.id,
    slug: 'migrate',
    title: 'Migrate',
    goal: '',
    constraints: [],
    nonGoals: [],
    qa: [],
    analysisSummary: '',
    phases: [
      { id: 'p1', title: 'Phase one', goal: '' },
      { id: 'p2', title: 'Phase two', goal: '' },
    ],
    items,
    policy: {
      maxConcurrent: 2,
      rules: [],
      defaultPipelineId: 'pl_full',
      onMissingEstimate: 'default',
    },
    decisions: [],
    deviations: [],
    followUps: [],
    caveats: [],
    status: 'executing',
    rev: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function harness(opts: {
  items: InitiativeItem[]
  pipelines?: string[]
  start?: (ws: string, blockId: string, pipelineId: string) => Promise<unknown>
  initiativeOverrides?: Partial<Initiative>
}) {
  const initiatives = makeInitiativeStore()
  const { store: blocks, rows: blockRows } = makeBlockStore()
  blockRows.set(frame.id, { ws: 'ws-1', block: frame })
  blockRows.set(initiativeBlock.id, { ws: 'ws-1', block: initiativeBlock })
  const events = new NoopEventPublisher()
  const service = new InitiativeService({
    workspaceRepository: {} as never,
    blockRepository: blocks,
    initiativeRepository: initiatives as never,
    initiativePresetRegistry: new InitiativePresetRegistry(),
    events,
    clock,
    idGenerator,
  })
  const notes: Array<{ type: string; body: string; reason?: string }> = []
  const notificationService = {
    raise: async (
      _ws: string,
      input: { type: string; body: string; payload?: { initiativeReason?: string } },
    ) => {
      notes.push({ type: input.type, body: input.body, reason: input.payload?.initiativeReason })
      return {} as never
    },
  } as unknown as NotificationService
  const start = vi.fn(opts.start ?? (async () => ({ id: 'exec-1' })))
  const executionService = { start } as unknown as ExecutionService
  const loop = new InitiativeLoopService({
    initiativeRepository: initiatives as never,
    initiativeService: service,
    blockRepository: blocks,
    pipelineRepository: makePipelineStore(opts.pipelines ?? ['pl_full']),
    executionService,
    events,
    clock,
    idGenerator,
    notificationService,
  })
  return { loop, initiatives, blocks, blockRows, notes, start, service }
}

beforeEach(() => {
  clockNow = 1_000
  idSeq = 0
})

describe('InitiativeLoopService', () => {
  it('spawns eligible items up to the concurrency cap and links them to the initiative', async () => {
    const h = harness({ items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })] })
    await h.initiatives.insert(
      'ws-1',
      makeInitiative([item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]),
    )

    const result = await h.loop.runDue(clockNow)
    expect(result.spawned).toBe(2) // cap = 2

    const entity = await h.initiatives.getByBlock('ws-1', initiativeBlock.id)
    const spawned = entity!.items!.filter((i) => i.status === 'in_progress')
    expect(spawned).toHaveLength(2)
    expect(h.start).toHaveBeenCalledTimes(2)
    // Each spawned block exists, is a task under the frame, and carries the initiative link.
    for (const it of spawned) {
      const block = await h.blocks.get('ws-1', it.blockId!)
      expect(block).toMatchObject({
        level: 'task',
        parentId: frame.id,
        initiativeId: initiativeBlock.id,
      })
    }
  })

  it('picks each task pipeline from the policy rules (estimate → pipeline)', async () => {
    const heavy = item({
      id: 'a',
      estimate: { complexity: 0.9, risk: 0.9, impact: 0.9, rationale: '' },
    })
    const h = harness({
      items: [heavy],
      pipelines: ['pl_full', 'pl_heavy'],
      initiativeOverrides: {},
    })
    await h.initiatives.insert(
      'ws-1',
      makeInitiative([heavy], {
        policy: {
          maxConcurrent: 2,
          rules: [{ pipelineId: 'pl_heavy', minRisk: 0.8 }],
          defaultPipelineId: 'pl_full',
          onMissingEstimate: 'default',
        },
      }),
    )
    await h.loop.runDue(clockNow)
    // `start(ws, blockId, pipelineId, initiatedBy, activate, origin, gatesOverride)` — a spawned
    // run is system-initiated (no initiator/activation), manual origin, and (here) no override.
    expect(h.start).toHaveBeenCalledWith(
      'ws-1',
      expect.any(String),
      'pl_heavy',
      undefined,
      undefined,
      undefined,
      undefined,
    )
  })

  it("threads a spawned item's per-run gate override into its run (spawn.gates)", async () => {
    // The preset gate-override seam (slice 2): an item's `spawn.gates` — a docs-refresh task's
    // human-review mapping — is passed straight through to `ExecutionService.start` as the run's
    // gate override, so the spawned run gates (or doesn't) per the preset, not the pipeline default.
    const gatedItem = item({ id: 'a', spawn: { gates: [true, false, false] } })
    const h = harness({ items: [gatedItem] })
    await h.initiatives.insert('ws-1', makeInitiative([gatedItem]))

    await h.loop.runDue(clockNow)

    expect(h.start).toHaveBeenCalledWith(
      'ws-1',
      expect.any(String),
      'pl_full',
      undefined,
      undefined,
      undefined,
      [true, false, false],
    )
  })

  it('passes no gate override for an item with no spawn decoration', async () => {
    const h = harness({ items: [item({ id: 'a' })] })
    await h.initiatives.insert('ws-1', makeInitiative([item({ id: 'a' })]))

    await h.loop.runDue(clockNow)

    expect(h.start).toHaveBeenCalledWith(
      'ws-1',
      expect.any(String),
      'pl_full',
      undefined,
      undefined,
      undefined,
      undefined,
    )
  })

  it("folds a spawned item's preset decoration onto the task block (taskType/taskTypeFields/fragmentIds/agentConfig)", async () => {
    // Slice 5's `buildTaskBlock` decoration: an item's `spawn` bag comes out as a first-class
    // TYPED task block (its `taskType`, a doc task's docKind/targetPath, its writing-style
    // fragments, per-agent config) instead of a bare description block — so a docs-refresh item
    // spawns a real doc task that classifies as `document`, not the default `feature`.
    const decorated = item({
      id: 'a',
      spawn: {
        taskType: 'document',
        taskTypeFields: { docKind: 'reference', targetPath: 'docs/api/reference.md' },
        fragmentIds: ['style.anti-llmisms', 'style.concise-actionable'],
        agentConfig: { 'tester.environment': 'local' },
      },
    })
    const h = harness({ items: [decorated] })
    await h.initiatives.insert('ws-1', makeInitiative([decorated]))

    await h.loop.runDue(clockNow)

    const entity = await h.initiatives.getByBlock('ws-1', initiativeBlock.id)
    const block = await h.blocks.get('ws-1', entity!.items![0]!.blockId!)
    expect(block).toMatchObject({
      level: 'task',
      parentId: frame.id,
      initiativeId: initiativeBlock.id,
      taskType: 'document',
      taskTypeFields: { docKind: 'reference', targetPath: 'docs/api/reference.md' },
      fragmentIds: ['style.anti-llmisms', 'style.concise-actionable'],
      agentConfig: { 'tester.environment': 'local' },
    })
  })

  it('defaults a document-typed spawn with no explicit fragments to the writing-style fragments (mirrors addTask)', async () => {
    // A `document` spawn that carries no `fragmentIds` still gets the default writing-style
    // fragments, exactly as `BoardService.addTask` seeds them — so a spawned doc task is
    // byte-identical to a hand-created one whether or not the preset supplied fragments.
    const decorated = item({
      id: 'a',
      spawn: { taskType: 'document', taskTypeFields: { docKind: 'reference' } },
    })
    const h = harness({ items: [decorated] })
    await h.initiatives.insert('ws-1', makeInitiative([decorated]))

    await h.loop.runDue(clockNow)

    const entity = await h.initiatives.getByBlock('ws-1', initiativeBlock.id)
    const block = await h.blocks.get('ws-1', entity!.items![0]!.blockId!)
    expect(block).toMatchObject({ taskType: 'document' })
    expect(block!.fragmentIds).toEqual([...DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS])
  })

  it('leaves a decoration-less spawned block bare (no taskType/taskTypeFields/fragmentIds/agentConfig)', async () => {
    // An item with no `spawn` bag (the generic-preset / no-preset case) must spawn a block
    // byte-identical to the pre-slice-5 shape — no empty decoration keys accreted, and no
    // `taskType` (so it classifies as the default `feature`, unchanged from before).
    const h = harness({ items: [item({ id: 'a' })] })
    await h.initiatives.insert('ws-1', makeInitiative([item({ id: 'a' })]))

    await h.loop.runDue(clockNow)

    const entity = await h.initiatives.getByBlock('ws-1', initiativeBlock.id)
    const block = await h.blocks.get('ws-1', entity!.items![0]!.blockId!)
    expect(block).not.toHaveProperty('taskType')
    expect(block).not.toHaveProperty('taskTypeFields')
    expect(block).not.toHaveProperty('fragmentIds')
    expect(block).not.toHaveProperty('agentConfig')
  })

  it('reconciles a finished task, copies the PR, and completes the initiative', async () => {
    const h = harness({ items: [item({ id: 'a' })] })
    await h.initiatives.insert('ws-1', makeInitiative([item({ id: 'a' })]))
    await h.loop.runDue(clockNow) // spawns item a
    const spawnedBlockId = (await h.initiatives.getByBlock('ws-1', initiativeBlock.id))!.items![0]!
      .blockId!

    // The spawned task's block finishes with a merged PR.
    await h.blocks.update('ws-1', spawnedBlockId, {
      status: 'done',
      pullRequest: { url: 'https://github.com/o/r/pull/9', number: 9 },
    })
    await h.loop.runDue(clockNow)

    const entity = await h.initiatives.getByBlock('ws-1', initiativeBlock.id)
    expect(entity!.status).toBe('done')
    expect(entity!.items![0]).toMatchObject({
      status: 'done',
      pr: { url: 'https://github.com/o/r/pull/9', number: 9 },
    })
    // The anchor block is flipped done, and a completion notification is raised.
    expect((await h.blocks.get('ws-1', initiativeBlock.id))!.status).toBe('done')
    expect(h.notes.some((n) => n.type === 'initiative')).toBe(true)
  })

  it('blocks a failed task, records a deviation, halts the phase, and notifies', async () => {
    const h = harness({ items: [item({ id: 'a' }), item({ id: 'b' })] })
    await h.initiatives.insert('ws-1', makeInitiative([item({ id: 'a' }), item({ id: 'b' })]))
    await h.loop.runDue(clockNow) // spawns a + b (cap 2)
    const before = await h.initiatives.getByBlock('ws-1', initiativeBlock.id)
    const failedBlockId = before!.items!.find((i) => i.id === 'a')!.blockId!

    await h.blocks.update('ws-1', failedBlockId, { status: 'blocked' })
    await h.loop.runDue(clockNow)

    const entity = await h.initiatives.getByBlock('ws-1', initiativeBlock.id)
    expect(entity!.items!.find((i) => i.id === 'a')!.status).toBe('blocked')
    expect(entity!.deviations!.some((d) => d.itemId === 'a')).toBe(true)
    expect(h.notes.some((n) => n.type === 'initiative')).toBe(true)
    // No new spawns while the phase is halted (b was already spawned; nothing new).
    expect(h.start).toHaveBeenCalledTimes(2)
  })

  it('leaves an item pending (not blocked) when the per-service task limit is hit', async () => {
    const h = harness({
      items: [item({ id: 'a' })],
      start: async () => {
        throw new ConflictError('Too many running tasks', 'task_limit_reached')
      },
    })
    await h.initiatives.insert('ws-1', makeInitiative([item({ id: 'a' })]))
    await h.loop.runDue(clockNow)

    const entity = await h.initiatives.getByBlock('ws-1', initiativeBlock.id)
    expect(entity!.items![0]).toMatchObject({ status: 'pending' })
    expect(entity!.items![0]!.blockId ?? null).toBeNull()
    // The half-created block was rolled back.
    expect(await h.blocks.listByWorkspace('ws-1')).toHaveLength(2) // frame + initiative block only
  })

  it('blocks an item whose pipeline no longer exists (config problem, never throws)', async () => {
    const missing = item({ id: 'a', pipelineId: 'pl_gone' })
    const h = harness({ items: [missing], pipelines: ['pl_full'] })
    await h.initiatives.insert('ws-1', makeInitiative([missing]))
    await h.loop.runDue(clockNow)

    const entity = await h.initiatives.getByBlock('ws-1', initiativeBlock.id)
    expect(entity!.items![0]!.status).toBe('blocked')
    expect(h.start).not.toHaveBeenCalled()
    expect(h.notes.some((n) => n.type === 'initiative')).toBe(true)
  })

  it('skips a paused initiative', async () => {
    const h = harness({ items: [item({ id: 'a' })] })
    await h.initiatives.insert('ws-1', makeInitiative([item({ id: 'a' })], { status: 'paused' }))
    const result = await h.loop.runDue(clockNow)
    expect(result.spawned).toBe(0)
    expect(h.start).not.toHaveBeenCalled()
  })

  // Phase checkpoints (D2): a phase flagged `checkpoint` PAUSES the initiative for human review once
  // its items settle, before the next phase spawns. Resume clears it and advances.
  describe('phase checkpoints (D2)', () => {
    /** p1 (checkpoint) holds item a; p2 holds item b. Only p1 is current at first. */
    const checkpointed = () =>
      makeInitiative([item({ id: 'a', phaseId: 'p1' }), item({ id: 'b', phaseId: 'p2' })], {
        phases: [
          { id: 'p1', title: 'Phase one', goal: '', checkpoint: true },
          { id: 'p2', title: 'Phase two', goal: '' },
        ],
      })

    it('pauses at a completed checkpoint phase and raises the checkpoint notification', async () => {
      const h = harness({ items: [item({ id: 'a', phaseId: 'p1' })] })
      await h.initiatives.insert('ws-1', checkpointed())

      await h.loop.runDue(clockNow) // spawns only item a (p1 is the current phase)
      const entity1 = await h.initiatives.getByBlock('ws-1', initiativeBlock.id)
      const spawnedA = entity1!.items!.find((i) => i.id === 'a')!.blockId!
      await h.blocks.update('ws-1', spawnedA, { status: 'done' })

      await h.loop.runDue(clockNow) // reconciles a done → checkpoint fires → pause

      const entity = await h.initiatives.getByBlock('ws-1', initiativeBlock.id)
      expect(entity!.status).toBe('paused')
      // The next phase did NOT spawn while paused.
      expect(entity!.items!.find((i) => i.id === 'b')!.status).toBe('pending')
      expect(h.start).toHaveBeenCalledTimes(1)
      // A `checkpoint` notification was raised (once).
      const checkpointNotes = h.notes.filter((n) => n.reason === 'checkpoint')
      expect(checkpointNotes).toHaveLength(1)
      expect(checkpointNotes[0]!.body).toContain('Phase one')
    })

    it('does not re-fire the checkpoint on a subsequent tick while still paused', async () => {
      const h = harness({ items: [item({ id: 'a', phaseId: 'p1' })] })
      await h.initiatives.insert('ws-1', checkpointed())
      await h.loop.runDue(clockNow)
      const spawnedA = (await h.initiatives.getByBlock('ws-1', initiativeBlock.id))!.items!.find(
        (i) => i.id === 'a',
      )!.blockId!
      await h.blocks.update('ws-1', spawnedA, { status: 'done' })
      await h.loop.runDue(clockNow) // pauses

      // A paused initiative is invisible to listExecuting, so runDue does nothing more.
      await h.loop.runDue(clockNow)
      expect(h.notes.filter((n) => n.reason === 'checkpoint')).toHaveLength(1)
    })

    it('resume clears the checkpoint and the next tick spawns the following phase', async () => {
      const h = harness({
        items: [item({ id: 'a', phaseId: 'p1' }), item({ id: 'b', phaseId: 'p2' })],
      })
      await h.initiatives.insert('ws-1', checkpointed())
      await h.loop.runDue(clockNow)
      const spawnedA = (await h.initiatives.getByBlock('ws-1', initiativeBlock.id))!.items!.find(
        (i) => i.id === 'a',
      )!.blockId!
      await h.blocks.update('ws-1', spawnedA, { status: 'done' })
      await h.loop.runDue(clockNow) // pauses at the checkpoint

      // Resume is the acknowledgment: it flips to executing AND stamps the cleared-at.
      const resumed = await h.service.resume('ws-1', initiativeBlock.id)
      expect(resumed!.status).toBe('executing')
      expect(resumed!.phases!.find((p) => p.id === 'p1')!.checkpointClearedAt).toBeDefined()

      await h.loop.runDue(clockNow) // p1 checkpoint cleared → phase two spawns
      const entity = await h.initiatives.getByBlock('ws-1', initiativeBlock.id)
      expect(entity!.items!.find((i) => i.id === 'b')!.status).toBe('in_progress')
      expect(h.start).toHaveBeenCalledTimes(2)
    })

    it('a tick that LOSES the pause CAS to a concurrent replica stays silent (no duplicate checkpoint card)', async () => {
      // Two sweeper replicas can both read `executing` at tick time and both reach the checkpoint
      // pause; the CAS lets only one win. The loser's `update` re-reads the now-`paused` entity and
      // no-ops — but `update` still returns the (paused) entity, so a bare `status === 'paused'`
      // guard would let the loser double-raise the card. Simulate the loser by intercepting the FIRST
      // executing→paused CAS: commit the pause ourselves (the winner) and report the CAS as LOST to
      // this caller, forcing the retry-then-no-op path. The losing tick must raise ZERO notifications.
      const h = harness({ items: [item({ id: 'a', phaseId: 'p1' })] })
      await h.initiatives.insert('ws-1', checkpointed())
      await h.loop.runDue(clockNow)
      const spawnedA = (await h.initiatives.getByBlock('ws-1', initiativeBlock.id))!.items!.find(
        (i) => i.id === 'a',
      )!.blockId!
      await h.blocks.update('ws-1', spawnedA, { status: 'done' })

      const realCas = h.initiatives.compareAndSwap
      let intercepted = false
      h.initiatives.compareAndSwap = async (ws, next, expectedRev) => {
        if (!intercepted && next.status === 'paused') {
          intercepted = true
          await realCas(ws, next, expectedRev) // the concurrent winner commits the pause first
          return false // ...but this caller lost the race
        }
        return realCas(ws, next, expectedRev)
      }

      await h.loop.runDue(clockNow) // reconcile → pendingCheckpoint → pauseAtCheckpoint loses, retries, no-ops

      expect((await h.initiatives.getByBlock('ws-1', initiativeBlock.id))!.status).toBe('paused')
      // The winner (a separate replica, not modelled here) raises the single card; this losing tick
      // must add none. Pre-fix it raised a spurious second `checkpoint` notification.
      expect(h.notes.filter((n) => n.reason === 'checkpoint')).toHaveLength(0)
    })
  })
})
