import type {
  KaizenGrading,
  KaizenGradingRepository,
  KaizenVerifiedCombo,
  KaizenVerifiedComboRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the Kaizen persistence (post-run grading + verified-combo
// library). Each facade persists these in its own store — D1 on Cloudflare, Drizzle/
// Postgres on Node — so this suite drives the SAME upsert → read assertions through
// whichever real repositories a runtime hands it, so a column or JSON blob mapped
// differently fails a test instead of shipping. Both runtimes invoke it over their real
// database.

function grading(overrides: Partial<KaizenGrading> & Pick<KaizenGrading, 'id'>): KaizenGrading {
  return {
    executionId: 'exec',
    blockId: 'blk',
    stepIndex: 0,
    agentKind: 'coder',
    model: 'workers-ai:m',
    promptVersion: 1,
    comboKey: 'coder|workers-ai:m|1',
    status: 'scheduled',
    grade: null,
    summary: '',
    recommendations: [],
    graderModel: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function combo(
  overrides: Partial<KaizenVerifiedCombo> & Pick<KaizenVerifiedCombo, 'comboKey'>,
): KaizenVerifiedCombo {
  return {
    agentKind: 'coder',
    model: 'workers-ai:m',
    promptVersion: 1,
    consecutiveHighGrades: 0,
    verified: false,
    verifiedAt: null,
    updatedAt: 1,
    ...overrides,
  }
}

/**
 * Assert a runtime's Kaizen repositories behave identically to the others. The two
 * `make*` callbacks return repos over the runtime's real store; ids are unique per case
 * so the shared database stays isolated.
 */
export function defineKaizenSuite(
  name: string,
  makeGradingRepo: () => KaizenGradingRepository,
  makeComboRepo: () => KaizenVerifiedComboRepository,
): void {
  describe(`[${name}] kaizen grading repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, e1: `e1-${tag}`, e2: `e2-${tag}` }
    }

    it('upserts, gets by id and by step, and lists per execution by step index', async () => {
      const repo = makeGradingRepo()
      const { ws, e1, e2 } = ids()
      await repo.upsert(ws, grading({ id: `${ws}-s1`, executionId: e1, stepIndex: 1 }))
      await repo.upsert(ws, grading({ id: `${ws}-s0`, executionId: e1, stepIndex: 0 }))
      await repo.upsert(ws, grading({ id: `${ws}-other`, executionId: e2, stepIndex: 0 }))

      expect((await repo.get(ws, `${ws}-s1`))?.stepIndex).toBe(1)
      expect((await repo.getByStep(ws, e1, 0))?.id).toBe(`${ws}-s0`)
      expect((await repo.listByExecution(ws, e1)).map((g) => g.id)).toEqual([
        `${ws}-s0`,
        `${ws}-s1`,
      ])
      // The other run's grading is excluded.
      expect((await repo.listByExecution(ws, e2)).map((g) => g.id)).toEqual([`${ws}-other`])
    })

    it('round-trips the grade, summary and recommendations array on completion', async () => {
      const repo = makeGradingRepo()
      const { ws, e1 } = ids()
      await repo.upsert(ws, grading({ id: `${ws}-g`, executionId: e1 }))
      await repo.upsert(
        ws,
        grading({
          id: `${ws}-g`,
          executionId: e1,
          status: 'complete',
          grade: 4,
          summary: 'mostly smooth',
          recommendations: ['state the framework', 'raise the token limit'],
          graderModel: 'anthropic:claude',
          updatedAt: 2,
        }),
      )
      const stored = await repo.get(ws, `${ws}-g`)
      expect(stored?.status).toBe('complete')
      expect(stored?.grade).toBe(4)
      expect(stored?.summary).toBe('mostly smooth')
      expect(stored?.recommendations).toEqual(['state the framework', 'raise the token limit'])
      expect(stored?.graderModel).toBe('anthropic:claude')
    })

    it('lists pending: scheduled rows plus stale running rows', async () => {
      const repo = makeGradingRepo()
      const { ws, e1 } = ids()
      await repo.upsert(
        ws,
        grading({
          id: `${ws}-sched`,
          executionId: e1,
          stepIndex: 0,
          status: 'scheduled',
          updatedAt: 100,
        }),
      )
      await repo.upsert(
        ws,
        grading({
          id: `${ws}-fresh`,
          executionId: e1,
          stepIndex: 1,
          status: 'running',
          updatedAt: 1000,
        }),
      )
      await repo.upsert(
        ws,
        grading({
          id: `${ws}-stale`,
          executionId: e1,
          stepIndex: 2,
          status: 'running',
          updatedAt: 10,
        }),
      )
      await repo.upsert(
        ws,
        grading({
          id: `${ws}-done`,
          executionId: e1,
          stepIndex: 3,
          status: 'complete',
          grade: 5,
          updatedAt: 5,
        }),
      )

      const pending = await repo.listPending(50, 100)
      const got = pending.filter((p) => p.workspaceId === ws).map((p) => p.grading.id)
      // scheduled + the running row older than the 50 cutoff; not the fresh running or the complete.
      expect(got).toContain(`${ws}-sched`)
      expect(got).toContain(`${ws}-stale`)
      expect(got).not.toContain(`${ws}-fresh`)
      expect(got).not.toContain(`${ws}-done`)
      // Each pending row is paired with its workspace id (the wire grading carries none).
      expect(pending.find((p) => p.grading.id === `${ws}-sched`)?.workspaceId).toBe(ws)
    })

    it('claims atomically: a scheduled or stale-running row is won once, a fresh running row is not', async () => {
      const repo = makeGradingRepo()
      const { ws, e1 } = ids()
      await repo.upsert(
        ws,
        grading({
          id: `${ws}-sc`,
          executionId: e1,
          stepIndex: 0,
          status: 'scheduled',
          updatedAt: 100,
        }),
      )
      await repo.upsert(
        ws,
        grading({
          id: `${ws}-fr`,
          executionId: e1,
          stepIndex: 1,
          status: 'running',
          updatedAt: 1000,
        }),
      )
      await repo.upsert(
        ws,
        grading({
          id: `${ws}-st`,
          executionId: e1,
          stepIndex: 2,
          status: 'running',
          updatedAt: 10,
        }),
      )

      // A scheduled row is won exactly once: the second claim (now `running` and fresh) loses.
      expect(await repo.claim(ws, `${ws}-sc`, 50, 2000)).toBe(true)
      expect((await repo.get(ws, `${ws}-sc`))?.status).toBe('running')
      expect(await repo.claim(ws, `${ws}-sc`, 50, 2001)).toBe(false)
      // A fresh running row (updatedAt past the stale cutoff) cannot be claimed.
      expect(await repo.claim(ws, `${ws}-fr`, 50, 2000)).toBe(false)
      // A stale running row (updatedAt before the cutoff) is re-claimable.
      expect(await repo.claim(ws, `${ws}-st`, 50, 2000)).toBe(true)
    })

    it('keeps verified-combo streak/verified state per key', async () => {
      const repo = makeComboRepo()
      const { ws } = ids()
      const key = `coder|m|1-${ws}`
      await repo.upsert(ws, combo({ comboKey: key, consecutiveHighGrades: 3 }))
      expect((await repo.getByKey(ws, key))?.consecutiveHighGrades).toBe(3)
      await repo.upsert(
        ws,
        combo({
          comboKey: key,
          consecutiveHighGrades: 5,
          verified: true,
          verifiedAt: 42,
          updatedAt: 9,
        }),
      )
      const stored = await repo.getByKey(ws, key)
      expect(stored?.verified).toBe(true)
      expect(stored?.verifiedAt).toBe(42)
      expect((await repo.listByWorkspace(ws)).map((c) => c.comboKey)).toContain(key)
    })
  })
}
