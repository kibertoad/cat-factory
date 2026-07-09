import { beforeEach, describe, expect, it } from 'vitest'
import type {
  Clock,
  IdGenerator,
  Notification,
  NotificationRepository,
  NotificationType,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { NotificationService } from './NotificationService.js'

// The service owns notification lifecycle (raise/dedup, escalate, clear) over an injected
// repository + clock. These fakes record state so each branch can be asserted without a DB.

const WS = 'ws_1'

/** An in-memory NotificationRepository keyed by id, scoped to a single workspace. */
function fakeRepo() {
  const rows = new Map<string, Notification>()
  const repo: NotificationRepository = {
    async get(_ws, id) {
      return rows.get(id) ?? null
    },
    async listOpen() {
      return [...rows.values()].filter((n) => n.status === 'open')
    },
    async findOpenByBlock(_ws, blockId, type) {
      return (
        [...rows.values()].find(
          (n) => n.status === 'open' && n.blockId === blockId && n.type === type,
        ) ?? null
      )
    },
    async upsert(_ws, n) {
      rows.set(n.id, { ...n })
    },
    async claimForAction(_ws, id, resolvedAt) {
      // Mirror the real repos' conditional UPDATE ... RETURNING: flip `open` → `acted` only
      // when the row is still open, returning the claimed row (null otherwise).
      const existing = rows.get(id)
      if (!existing || existing.status !== 'open') return null
      const claimed: Notification = { ...existing, status: 'acted', resolvedAt }
      rows.set(id, claimed)
      return { ...claimed }
    },
    async escalateStaleOpen(_ws, cutoff) {
      // Mirror the real repos' single UPDATE ... RETURNING: flip every open, still-normal
      // card created at or before the cutoff and return the escalated rows.
      const escalated: Notification[] = []
      for (const n of rows.values()) {
        if (n.status !== 'open') continue
        if ((n.severity ?? 'normal') !== 'normal') continue
        if (n.createdAt > cutoff) continue
        const updated: Notification = { ...n, severity: 'urgent' }
        rows.set(n.id, updated)
        escalated.push({ ...updated })
      }
      return escalated
    },
    async upsertOpenForBlock(_ws, n) {
      // Mirror the partial-index dedup: an existing open card for (block, type) is updated
      // in place (id/severity/createdAt preserved); otherwise insert. Returns the canonical
      // persisted row (the existing card's id wins a concurrent double-raise).
      const existing = [...rows.values()].find(
        (r) => r.status === 'open' && r.blockId === n.blockId && r.type === n.type,
      )
      if (existing) {
        const merged = {
          ...existing,
          executionId: n.executionId,
          title: n.title,
          body: n.body,
          payload: n.payload,
          resolvedAt: n.resolvedAt,
        }
        rows.set(existing.id, merged)
        return { ...merged }
      }
      rows.set(n.id, { ...n })
      return { ...n }
    },
  }
  return { repo, rows }
}

function makeService(now: () => number) {
  const { repo, rows } = fakeRepo()
  let seq = 0
  const idGenerator: IdGenerator = { next: (p = 'id') => `${p}_${++seq}` }
  const clock: Clock = { now }
  // `act` guards on the workspace existing; a stub whose `get` resolves is enough here.
  const workspaceRepository = {
    async get(id: string) {
      return { id } as unknown
    },
  } as unknown as WorkspaceRepository
  const delivered: Notification[] = []
  const service = new NotificationService({
    notificationRepository: repo,
    workspaceRepository,
    idGenerator,
    clock,
    channel: {
      async deliver(_ws, n) {
        delivered.push(n)
      },
    },
  })
  return { service, rows, delivered }
}

const raiseInput = (over: Partial<Parameters<NotificationService['raise']>[1]> = {}) => ({
  type: 'decision_required' as NotificationType,
  blockId: 'blk_1',
  executionId: 'exec_1',
  title: 'waiting',
  body: 'open the task',
  ...over,
})

describe('NotificationService', () => {
  let time = 0
  beforeEach(() => {
    time = 1_000_000
  })

  it('clearWaitingDecision dismisses the open decision_required card on a block', async () => {
    const { service, rows } = makeService(() => time)
    const raised = await service.raise(WS, raiseInput())
    expect(raised.status).toBe('open')

    await service.clearWaitingDecision(WS, 'blk_1')
    expect(rows.get(raised.id)?.status).toBe('dismissed')
    expect(await service.listOpen(WS)).toHaveLength(0)
  })

  it('clearWaitingDecision dismisses the follow-up companion gate card too', async () => {
    const { service, rows } = makeService(() => time)
    const raised = await service.raise(WS, raiseInput({ type: 'followup_pending' }))
    expect(raised.status).toBe('open')

    await service.clearWaitingDecision(WS, 'blk_1')
    expect(rows.get(raised.id)?.status).toBe('dismissed')
    expect(await service.listOpen(WS)).toHaveLength(0)
  })

  it('clearWaitingDecision only touches gate cards, leaving human-actionable ones open', async () => {
    const { service } = makeService(() => time)
    await service.raise(WS, raiseInput({ type: 'merge_review' }))
    await service.raise(WS, raiseInput({ type: 'decision_required' }))
    await service.raise(WS, raiseInput({ type: 'followup_pending', blockId: 'blk_1' }))

    await service.clearWaitingDecision(WS, 'blk_1')
    const open = await service.listOpen(WS)
    expect(open.map((n) => n.type)).toEqual(['merge_review'])
  })

  it('clearWaitingDecision is a no-op when nothing is open', async () => {
    const { service } = makeService(() => time)
    await expect(service.clearWaitingDecision(WS, 'blk_1')).resolves.toBeUndefined()
  })

  it('escalateStale flips a long-waiting card to urgent, and clearing it then removes it', async () => {
    const { service, rows } = makeService(() => time)
    const raised = await service.raise(WS, raiseInput())

    // Not yet past the threshold → stays normal.
    expect(await service.escalateStale(WS, 60_000, time + 30_000)).toBe(0)
    expect(rows.get(raised.id)?.severity).toBe('normal')

    // Past the threshold → escalated red once (and only once).
    expect(await service.escalateStale(WS, 60_000, time + 90_000)).toBe(1)
    expect(rows.get(raised.id)?.severity).toBe('urgent')
    expect(await service.escalateStale(WS, 60_000, time + 120_000)).toBe(0)

    // Once the run advances past the decision, clearing dismisses the (escalated) card so
    // the inbox no longer shows a settled decision as overdue.
    await service.clearWaitingDecision(WS, 'blk_1')
    expect(await service.listOpen(WS)).toHaveLength(0)
  })

  it('raise returns the canonical persisted card when a concurrent insert won (no phantom id)', async () => {
    const { repo, rows } = fakeRepo()
    // A concurrent raise already inserted THE open card for (blk_1, decision_required)…
    rows.set('ntf_canonical', {
      id: 'ntf_canonical',
      type: 'decision_required',
      status: 'open',
      severity: 'normal',
      blockId: 'blk_1',
      executionId: 'exec_prev',
      title: 'waiting',
      body: 'open the task',
      payload: null,
      createdAt: 123,
      resolvedAt: null,
    })
    // …but THIS raise's read-before-write missed it (the race the partial index closes), so it
    // mints a fresh optimistic id that the atomic upsert then discards in favour of the existing row.
    repo.findOpenByBlock = async () => null

    let seq = 0
    const idGenerator: IdGenerator = { next: (p = 'id') => `${p}_${++seq}` }
    const delivered: Notification[] = []
    const service = new NotificationService({
      notificationRepository: repo,
      workspaceRepository: {} as unknown as WorkspaceRepository,
      idGenerator,
      clock: { now: () => 2_000_000 },
      channel: {
        async deliver(_ws, n) {
          delivered.push(n)
        },
      },
    })

    const result = await service.raise(WS, raiseInput({ title: 'still waiting' }))

    // The optimistic in-memory id is dropped; the CANONICAL row's id is returned AND delivered —
    // not a phantom the inbox can't resolve.
    expect(result.id).toBe('ntf_canonical')
    expect(delivered.at(-1)?.id).toBe('ntf_canonical')
    // The dedup held: one open row, carrying the new content, resolvable by the returned id.
    const open = await service.listOpen(WS)
    expect(open).toHaveLength(1)
    expect(open[0]?.title).toBe('still waiting')
    expect(await service.get(WS, result.id)).not.toBeNull()
  })

  it('act claims the card, runs the side effect once, and marks it acted + delivered', async () => {
    const { service, rows, delivered } = makeService(() => time)
    const raised = await service.raise(WS, raiseInput({ type: 'merge_review' }))

    let calls = 0
    const acted = await service.act(WS, raised.id, async () => {
      calls++
    })
    expect(calls).toBe(1)
    expect(acted.status).toBe('acted')
    expect(acted.resolvedAt).toBe(time)
    expect(rows.get(raised.id)?.status).toBe('acted')
    expect(delivered.at(-1)?.status).toBe('acted')
  })

  it('act on an already-resolved card is a no-op (idempotent, no double side effect)', async () => {
    const { service, rows } = makeService(() => time)
    const raised = await service.raise(WS, raiseInput({ type: 'merge_review' }))
    await service.act(WS, raised.id, async () => {})

    let calls = 0
    const again = await service.act(WS, raised.id, async () => {
      calls++
    })
    expect(calls).toBe(0)
    expect(again.status).toBe('acted')
    expect(rows.get(raised.id)?.status).toBe('acted')
  })

  it('two concurrent acts fire the side effect EXACTLY once (atomic claim)', async () => {
    const { service } = makeService(() => time)
    const raised = await service.raise(WS, raiseInput({ type: 'merge_review' }))

    let calls = 0
    const [a, b] = await Promise.all([
      service.act(WS, raised.id, async () => {
        calls++
      }),
      service.act(WS, raised.id, async () => {
        calls++
      }),
    ])
    // The atomic `open` → `acted` claim admits only one act; the loser skips its side effect
    // and returns the settled row.
    expect(calls).toBe(1)
    expect(a.status).toBe('acted')
    expect(b.status).toBe('acted')
  })

  it('act reopens the card and rethrows when the side effect fails, staying retryable', async () => {
    const { service, rows, delivered } = makeService(() => time)
    const raised = await service.raise(WS, raiseInput({ type: 'ci_failed' }))

    await expect(
      service.act(WS, raised.id, async () => {
        throw new Error('retry failed')
      }),
    ).rejects.toThrow('retry failed')

    // Reverted to open so the human can act again, and re-delivered as open.
    expect(rows.get(raised.id)?.status).toBe('open')
    expect(rows.get(raised.id)?.resolvedAt).toBeNull()
    expect(delivered.at(-1)?.status).toBe('open')

    // A follow-up act now succeeds and settles it.
    let calls = 0
    const acted = await service.act(WS, raised.id, async () => {
      calls++
    })
    expect(calls).toBe(1)
    expect(acted.status).toBe('acted')
  })

  it('re-raise preserves an already-escalated severity and the original createdAt', async () => {
    const { service, rows } = makeService(() => time)
    const first = await service.raise(WS, raiseInput())
    await service.escalateStale(WS, 60_000, time + 90_000)
    expect(rows.get(first.id)?.severity).toBe('urgent')

    time += 500_000
    const reraised = await service.raise(WS, raiseInput({ title: 'still waiting' }))
    expect(reraised.id).toBe(first.id)
    expect(reraised.severity).toBe('urgent')
    expect(reraised.createdAt).toBe(first.createdAt)
  })
})
