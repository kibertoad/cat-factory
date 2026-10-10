import { describe, expect, it } from 'vitest'
import type { ConformanceApp, ConformanceHarness } from './harness.js'

// Cross-runtime parity for the opt-in review-debt friction guard on task creation
// (`backend/docs/review-debt-friction.md`). The verdict itself is a pure contracts function with
// its own unit tests; what this suite proves is the END-TO-END wiring on each facade: the four new
// `workspace_settings` columns round-trip through the settings route, the board service reads them
// + the open notifications through its optional seams, and `addTask` returns the right 409 shape.
// A facade that forgot the settings columns, or that didn't thread the friction seams into
// `BoardService`, fails a test here instead of shipping — the whole point of the parity suite.
//
// It drives real HTTP against `app.fetch` and seeds the debt as REAL open notifications through the
// facade's own store (`notificationRepository().upsert`), so the guard reads exactly what a live
// parked run would have raised.

export function defineReviewFrictionSuite(harness: ConformanceHarness): void {
  const { name } = harness

  describe(`[${name}] review-debt friction on task creation (HTTP)`, () => {
    let seq = 0
    const uniq = () => {
      seq += 1
      return `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    /** Create a service frame (a valid task container) and return its block id. */
    async function makeFrame(app: ConformanceApp, wsId: string): Promise<string> {
      const res = await app.call<{ id: string }>('POST', `/workspaces/${wsId}/blocks`, {
        type: 'service',
        position: { x: 0, y: 0 },
      })
      expect(res.status).toBe(201)
      return res.body.id
    }

    /**
     * Seed one OPEN review-wait notification as a unit of debt. Defaults to a `merge_review` card;
     * the `type` override lets a test place two DISTINCT review-wait cards on the SAME block (the
     * notifications table is UNIQUE on `(workspace_id, block_id, type)`, so two cards on one block
     * must differ by type).
     */
    async function seedDebt(
      app: ConformanceApp,
      wsId: string,
      blockId: string,
      createdAt: number,
      type: 'merge_review' | 'human_review' = 'merge_review',
    ): Promise<void> {
      await app.notificationRepository().upsert(wsId, {
        id: `ntf-${uniq()}`,
        type,
        status: 'open',
        blockId,
        executionId: null,
        title: 'Merge review',
        body: 'A PR is waiting on a human review decision.',
        createdAt,
        resolvedAt: null,
      })
    }

    const setFriction = (app: ConformanceApp, wsId: string, patch: Record<string, unknown>) =>
      app.call('PUT', `/workspaces/${wsId}/settings`, patch)

    const createTask = (app: ConformanceApp, wsId: string, frameId: string, ack?: boolean) =>
      app.call<{ error?: { details?: { reason?: string } } }>(
        'POST',
        `/workspaces/${wsId}/blocks/${frameId}/tasks`,
        ack ? { title: `T ${uniq()}`, acknowledgeReviewDebt: true } : { title: `T ${uniq()}` },
      )

    it('friction off (default): task creation is never gated, even with a full review queue', async () => {
      const app = harness.makeApp()
      const wsId = (await app.createWorkspace()).workspace.id
      const frameId = await makeFrame(app, wsId)
      await seedDebt(app, wsId, `b1-${uniq()}`, 1)
      await seedDebt(app, wsId, `b2-${uniq()}`, 1)
      const res = await createTask(app, wsId, frameId)
      expect(res.status).toBe(201)
    })

    it('warn tier: 409 review_debt_warn once the count crosses the threshold; acknowledge tunnels through', async () => {
      const app = harness.makeApp()
      const wsId = (await app.createWorkspace()).workspace.id
      const frameId = await makeFrame(app, wsId)
      expect(
        (await setFriction(app, wsId, { reviewFrictionMode: 'warn', reviewFrictionWarnCount: 2 }))
          .status,
      ).toBe(200)

      // One card < warn count ⇒ still allowed.
      await seedDebt(app, wsId, `b1-${uniq()}`, 1)
      expect((await createTask(app, wsId, frameId)).status).toBe(201)

      // A second distinct block reaches the warn count ⇒ soft friction.
      await seedDebt(app, wsId, `b2-${uniq()}`, 1)
      const warned = await createTask(app, wsId, frameId)
      expect(warned.status).toBe(409)
      expect(warned.body.error?.details?.reason).toBe('review_debt_warn')

      // The acknowledge flag lets the human proceed past the soft tier.
      const acked = await createTask(app, wsId, frameId, true)
      expect(acked.status).toBe(201)
    })

    it('enforce/count: hard block that an acknowledge can NOT tunnel through', async () => {
      const app = harness.makeApp()
      const wsId = (await app.createWorkspace()).workspace.id
      const frameId = await makeFrame(app, wsId)
      expect(
        (
          await setFriction(app, wsId, {
            reviewFrictionMode: 'enforce',
            reviewFrictionWarnCount: 1,
            reviewFrictionBlockCount: 2,
          })
        ).status,
      ).toBe(200)

      await seedDebt(app, wsId, `b1-${uniq()}`, 1)
      await seedDebt(app, wsId, `b2-${uniq()}`, 1)

      const blocked = await createTask(app, wsId, frameId, true)
      expect(blocked.status).toBe(409)
      expect(blocked.body.error?.details?.reason).toBe('review_debt_blocked')
    })

    it('deduplicates debt per block: two open cards on ONE block count once', async () => {
      const app = harness.makeApp()
      const wsId = (await app.createWorkspace()).workspace.id
      const frameId = await makeFrame(app, wsId)
      expect(
        (await setFriction(app, wsId, { reviewFrictionMode: 'warn', reviewFrictionWarnCount: 2 }))
          .status,
      ).toBe(200)
      // Two open review-wait cards of DISTINCT types, but on the SAME block ⇒ one unit of debt <
      // warn count (they dedup per block; distinct types are required by the notifications table's
      // `(workspace_id, block_id, type)` uniqueness).
      const oneBlock = `b-dupe-${uniq()}`
      await seedDebt(app, wsId, oneBlock, 1, 'merge_review')
      await seedDebt(app, wsId, oneBlock, 2, 'human_review')
      expect((await createTask(app, wsId, frameId)).status).toBe(201)
    })
  })
}
