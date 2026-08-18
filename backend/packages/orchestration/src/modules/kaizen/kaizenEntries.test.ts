import type { Block, KaizenGrading, KaizenVerifiedCombo, Service } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { KaizenEntryReader } from './kaizenEntries.js'

// The join is the feature here: a stored grading names a run, a step and a block id, none of which
// tells a reader WHAT was being built. These cases pin the three things that join can get wrong:
// resolving the service the app addresses (the frame block, not the account service id), degrading
// to null rather than to a blank when the board has moved on, and doing it in a bounded number of
// reads rather than one per entry.

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

function block(id: string, title: string, level: Block['level']): Block {
  return { id, title, description: '', level, status: 'in_progress' } as Block
}

const TASK = block('blk_task', 'Add rate limiting', 'task')
const FRAME = block('blk_frame', 'Checkout', 'frame')
const SERVICE = { id: 'svc_1', frameBlockId: 'blk_frame' } as Service

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
  const blocks = new Map((opts.blocks ?? [TASK, FRAME]).map((b) => [b.id, b]))
  const calls = { findBlocks: 0, listServices: 0, combos: 0 }
  const instance = new KaizenEntryReader({
    gradings: {
      get: async (_ws, id) => rows.get(id) ?? null,
      listPage: async (_ws, query) => [...rows.values()].slice(0, query.limit),
      setAcknowledgement: async (_ws, id, ack) => {
        const row = rows.get(id)
        if (!row) return null
        if (!ack) {
          const cleared = {
            ...row,
            acknowledgedAt: null,
            acknowledgedBy: null,
            acknowledgementNote: null,
          }
          rows.set(id, cleared)
          return cleared
        }
        // The store's own guard: an already-acknowledged row keeps the first triage.
        if (row.acknowledgedAt !== null) return row
        const next = {
          ...row,
          acknowledgedAt: ack.at,
          acknowledgedBy: ack.by,
          acknowledgementNote: ack.note,
        }
        rows.set(id, next)
        return next
      },
    },
    combos: {
      listByWorkspace: async () => {
        calls.combos++
        return opts.combos ?? [COMBO]
      },
    },
    findBlocks: async (ids) => {
      calls.findBlocks++
      return ids
        .map((id) => blocks.get(id))
        .filter((b): b is Block => !!b)
        .map((b) => ({
          workspaceId: 'ws_1',
          serviceId: b.id === 'blk_task' ? 'svc_1' : null,
          block: b,
        }))
    },
    listServices: async (ids) => {
      calls.listServices++
      return [SERVICE].filter((s) => ids.includes(s.id))
    },
    clock: { now: () => 1_000 },
  })
  return { reader: instance, calls }
}

describe('KaizenEntryReader', () => {
  it('joins the board context a follow-up needs, addressing the service by its frame block', async () => {
    const { reader: r } = reader()
    const [entry] = await r.listEntries('ws_1', { limit: 10 })

    expect(entry?.taskId).toBe('blk_task')
    expect(entry?.task).toEqual({
      title: 'Add rate limiting',
      status: 'in_progress',
      // The id `/api/v1/services` speaks, NOT the account-owned `svc_1` a caller cannot address.
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
    // One batched block read for the page's tasks, one for the frames behind them, one service
    // read and one combo read: constant in the page size, which is what keeps a 100-row page from
    // being hundreds of round-trips.
    expect(calls).toEqual({ findBlocks: 2, listServices: 1, combos: 1 })
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
