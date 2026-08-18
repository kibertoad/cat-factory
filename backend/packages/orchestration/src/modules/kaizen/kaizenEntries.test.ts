import type { Block, KaizenGrading, KaizenVerifiedCombo } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { KaizenEntryReader } from './kaizenEntries.js'

// The join is the feature here: a stored grading names a run, a step and a block id, none of which
// tells a reader WHAT was being built. These cases pin the three things that join can get wrong:
// resolving the service the way the rest of `/api/v1` does (walking board ancestry to the frame,
// which is the id a caller can address), degrading to null rather than to a blank when the board
// has moved on, and doing it in a bounded number of reads rather than one per entry.

function grading(over: Partial<KaizenGrading> & Pick<KaizenGrading, 'id'>): KaizenGrading {
  return {
    executionId: 'run_1',
    blockId: 'blk_task',
    stepIndex: 0,
    agentKind: 'coder',
    model: 'anthropic:claude',
    promptVersion: 3,
    comboKey: 'coder|anthropic:claude|3',
    status: 'complete',
    grade: 2,
    summary: 'thrashed on the build',
    recommendations: ['name the package manager'],
    graderModel: 'anthropic:claude',
    error: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgementNote: null,
    createdAt: 10,
    updatedAt: 10,
    ...over,
  }
}

function block(id: string, title: string, level: Block['level'], parentId?: string): Block {
  return { id, title, description: '', level, status: 'in_progress', parentId } as Block
}

// A task under a module under a frame: the deepest containment the board admits, so the walk has
// to take two hops to reach the service.
const TASK = block('blk_task', 'Add rate limiting', 'task', 'blk_module')
const MODULE = block('blk_module', 'Payments', 'module', 'blk_frame')
const FRAME = block('blk_frame', 'Checkout', 'frame')

const COMBO: KaizenVerifiedCombo = {
  comboKey: 'coder|anthropic:claude|3',
  agentKind: 'coder',
  model: 'anthropic:claude',
  promptVersion: 3,
  consecutiveHighGrades: 2,
  verified: false,
  verifiedAt: null,
  updatedAt: 5,
}

function reader(
  opts: { rows?: KaizenGrading[]; blocks?: Block[]; combos?: KaizenVerifiedCombo[] } = {},
) {
  const rows = new Map((opts.rows ?? [grading({ id: 'kzn_1' })]).map((r) => [r.id, r]))
  const blocks = new Map((opts.blocks ?? [TASK, MODULE, FRAME]).map((b) => [b.id, b]))
  const calls = { findBlocks: 0, combos: 0 }
  const instance = new KaizenEntryReader({
    gradings: {
      get: async (_ws, id) => rows.get(id) ?? null,
      listPage: async (_ws, query) => [...rows.values()].slice(0, query.limit),
      setAcknowledgement: async (_ws, id, ack, now) => {
        const row = rows.get(id)
        if (!row) return null
        if (!ack) {
          // The store's own guard: nothing to clear means nothing written, `updatedAt` included.
          if (row.acknowledgedAt === null) return row
          const cleared = {
            ...row,
            acknowledgedAt: null,
            acknowledgedBy: null,
            acknowledgementNote: null,
            updatedAt: now,
          }
          rows.set(id, cleared)
          return cleared
        }
        // The store's own guard: an already-acknowledged row keeps the first triage.
        if (row.acknowledgedAt !== null) return row
        const next = {
          ...row,
          acknowledgedAt: now,
          acknowledgedBy: ack.by,
          acknowledgementNote: ack.note,
          updatedAt: now,
        }
        rows.set(id, next)
        return next
      },
    },
    combos: {
      listByKeys: async (_ws, keys) => {
        calls.combos++
        return (opts.combos ?? [COMBO]).filter((c) => keys.includes(c.comboKey))
      },
    },
    findBlocks: async (ids) => {
      calls.findBlocks++
      return ids.map((id) => blocks.get(id)).filter((b): b is Block => !!b)
    },
    clock: { now: () => 1_000 },
  })
  return { reader: instance, calls }
}

describe('KaizenEntryReader', () => {
  it('joins the board context a follow-up needs, walking ancestry to the service frame', async () => {
    const { reader: r } = reader()
    const [entry] = await r.listEntries('ws_1', { limit: 10 })

    expect(entry?.taskId).toBe('blk_task')
    expect(entry?.task).toEqual({
      title: 'Add rate limiting',
      status: 'in_progress',
      // The id `/api/v1/services` speaks, reached the same way `GET /api/v1/tasks/{id}` reaches
      // it: up the parent chain, through the module, to the enclosing frame.
      serviceId: 'blk_frame',
      serviceTitle: 'Checkout',
    })
    expect(entry?.combo).toEqual({ consecutiveHighGrades: 2, verified: false, verifiedAt: null })
  })

  it('resolves a whole page in a bounded number of reads, never one per entry', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => grading({ id: `kzn_${i}`, stepIndex: i }))
    const { reader: r, calls } = reader({ rows })
    const entries = await r.listEntries('ws_1', { limit: 25 })

    expect(entries).toHaveLength(25)
    // One batched block read per LEVEL walked (tasks, then their modules, then the frames) and one
    // combo read naming the page's keys: constant in the page size, which is what keeps a 100-row
    // page from being hundreds of round-trips.
    expect(calls).toEqual({ findBlocks: 3, combos: 1 })
  })

  it('asks the combo store only for the keys the page names, never the whole library', async () => {
    const asked: string[][] = []
    const instance = new KaizenEntryReader({
      gradings: {
        get: async () => null,
        listPage: async () => [grading({ id: 'kzn_1' }), grading({ id: 'kzn_2' })],
        setAcknowledgement: async () => null,
      },
      combos: {
        listByKeys: async (_ws, keys) => {
          asked.push(keys)
          return []
        },
      },
      findBlocks: async () => [],
      clock: { now: () => 1_000 },
    })
    await instance.listEntries('ws_1', { limit: 10 })

    // Both rows share a combo, so the read names it ONCE: the query is keyed on what the page
    // holds, not on how many rows hold it.
    expect(asked).toEqual([['coder|anthropic:claude|3']])
  })

  it('withholds a service whose frame has been deleted rather than naming an unresolvable id', async () => {
    // The task survives, its frame does not. Answering `serviceId` here would hand the caller an
    // id `GET /api/v1/services/{serviceId}` cannot resolve.
    const { reader: r } = reader({ blocks: [TASK, MODULE] })
    const [entry] = await r.listEntries('ws_1', { limit: 10 })

    expect(entry?.task).toEqual({
      title: 'Add rate limiting',
      status: 'in_progress',
      serviceId: null,
      serviceTitle: null,
    })
  })

  it('resolves a grading anchored on the frame itself to that frame', async () => {
    // How a bootstrap or blueprint run is graded: the block IS the service frame.
    const { reader: r } = reader({ rows: [grading({ id: 'kzn_1', blockId: 'blk_frame' })] })
    const [entry] = await r.listEntries('ws_1', { limit: 10 })

    expect(entry?.task).toMatchObject({ serviceId: 'blk_frame', serviceTitle: 'Checkout' })
  })

  it('reports a deleted task and an ungraded combo as null rather than as blanks', async () => {
    const { reader: r } = reader({ blocks: [], combos: [] })
    const [entry] = await r.listEntries('ws_1', { limit: 10 })

    expect(entry?.task).toBeNull()
    expect(entry?.combo).toBeNull()
    // The id the row recorded still answers: it is a fact about the run, not about the board now.
    expect(entry?.taskId).toBe('blk_task')
  })

  it('acknowledges once and keeps the first triage on a repeat', async () => {
    const { reader: r } = reader()
    const first = await r.acknowledge('ws_1', 'kzn_1', {
      acknowledged: true,
      note: 'CF-12',
      actor: 'usr_1',
    })
    expect(first).toMatchObject({
      acknowledged: true,
      acknowledgedAt: 1_000,
      acknowledgedBy: 'usr_1',
      // The row's own change stamp moves with the triage, so a consumer watermarking on
      // `updatedAt` sees the backlog shrink. It was 10 before.
      updatedAt: 1_000,
    })

    const again = await r.acknowledge('ws_1', 'kzn_1', {
      acknowledged: true,
      note: 'later',
      actor: 'usr_2',
    })
    expect(again.acknowledgedBy).toBe('usr_1')
    expect(again.acknowledgementNote).toBe('CF-12')

    const cleared = await r.acknowledge('ws_1', 'kzn_1', {
      acknowledged: false,
      note: null,
      actor: 'usr_1',
    })
    expect(cleared.acknowledged).toBe(false)
  })

  it('refuses an entry the grader has not settled, and an id the workspace does not hold', async () => {
    const { reader: r } = reader({
      rows: [grading({ id: 'kzn_live', status: 'running', grade: null, recommendations: [] })],
    })

    await expect(
      r.acknowledge('ws_1', 'kzn_live', { acknowledged: true, note: null, actor: 'usr_1' }),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'kaizen_entry_not_settled' } })

    await expect(
      r.acknowledge('ws_1', 'kzn_missing', { acknowledged: true, note: null, actor: 'usr_1' }),
    ).rejects.toMatchObject({ code: 'not_found', details: { reason: 'kaizen_entry_not_found' } })

    // Clearing is allowed whatever the grading state: it only ever removes an acknowledgement.
    await expect(
      r.acknowledge('ws_1', 'kzn_live', { acknowledged: false, note: null, actor: 'usr_1' }),
    ).resolves.toMatchObject({ acknowledged: false })
  })
})
