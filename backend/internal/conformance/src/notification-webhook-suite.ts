import type { NotificationWebhookRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the outbound notification-webhook store — the per-workspace endpoint a
// HEADLESS integration registers so a parked run reaches it by push instead of polling. Each
// facade persists it in its own store (D1 on Cloudflare, Postgres on Node), and both encode the
// `types` / `run_events` / `alert_events` filters as JSON columns and `enabled` as an integer. This suite drives the SAME
// put → get → overwrite → delete assertions through whichever real repository a runtime hands it,
// so a column mapped differently (an unparsed filter, a boolean stored as text) fails a test
// instead of shipping a webhook that silently delivers the wrong set — or nothing.
//
// See docs/initiatives/headless-clarification-loop.md (D3).

/**
 * Assert a runtime's {@link NotificationWebhookRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; workspace ids are unique per run so a
 * shared database stays isolated between cases.
 */
export function defineNotificationWebhookSuite(
  name: string,
  makeRepo: () => NotificationWebhookRepository,
): void {
  describe(`[${name}] notification webhook repository parity`, () => {
    let seq = 0
    const nextWorkspace = () => {
      seq += 1
      return `ws-${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    it('round-trips an endpoint with both filters, the enabled flag and a sealed secret', async () => {
      const repo = makeRepo()
      const ws = nextWorkspace()
      await repo.put({
        workspaceId: ws,
        url: 'https://example.test/hooks/cat-factory',
        types: ['requirement_review', 'fork_decision_pending'],
        runEvents: ['run.completed', 'run.failed'],
        alertEvents: ['platform_health.firing', 'platform_health.resolved'],
        enabled: true,
        secretSealed: 'sealed-blob',
        updatedAt: 42,
      })

      const stored = await repo.get(ws)
      expect(stored).toEqual({
        workspaceId: ws,
        url: 'https://example.test/hooks/cat-factory',
        types: ['requirement_review', 'fork_decision_pending'],
        runEvents: ['run.completed', 'run.failed'],
        alertEvents: ['platform_health.firing', 'platform_health.resolved'],
        enabled: true,
        secretSealed: 'sealed-blob',
        updatedAt: 42,
      })
    })

    it('stores an empty filter and a disabled, secret-less endpoint faithfully', async () => {
      // An EMPTY filter is meaningful, and means OPPOSITE things per column: the channel reads an
      // empty `types` as "the default types", while both event families read theirs as "none". So
      // each must survive the round-trip as an empty array rather than collapsing to
      // null/undefined — on one of the three that would start a firehose, and on the other two it
      // would page somebody. A disabled endpoint with no signing secret is the other end of the
      // shape space.
      const repo = makeRepo()
      const ws = nextWorkspace()
      await repo.put({
        workspaceId: ws,
        url: 'https://example.test/quiet',
        types: [],
        runEvents: [],
        alertEvents: [],
        enabled: false,
        secretSealed: null,
        updatedAt: 7,
      })

      const stored = await repo.get(ws)
      expect(stored?.types).toEqual([])
      expect(stored?.runEvents).toEqual([])
      expect(stored?.alertEvents).toEqual([])
      expect(stored?.enabled).toBe(false)
      expect(stored?.secretSealed).toBeNull()
    })

    it('replaces the workspace row on a second put (one endpoint per workspace)', async () => {
      const repo = makeRepo()
      const ws = nextWorkspace()
      await repo.put({
        workspaceId: ws,
        url: 'https://old.test/hook',
        types: ['ci_failed'],
        runEvents: ['run.started'],
        alertEvents: ['platform_health.firing'],
        enabled: true,
        secretSealed: 'old',
        updatedAt: 1,
      })
      await repo.put({
        workspaceId: ws,
        url: 'https://new.test/hook',
        types: ['merge_review'],
        runEvents: [],
        alertEvents: [],
        enabled: false,
        secretSealed: 'new',
        updatedAt: 2,
      })

      const stored = await repo.get(ws)
      expect(stored?.url).toBe('https://new.test/hook')
      expect(stored?.types).toEqual(['merge_review'])
      // Both event subscriptions are REPLACED, not merged: dropping every event must actually
      // silence the endpoint rather than leaving the prior `run.started` (or a live alert
      // subscription somebody has just turned off) behind.
      expect(stored?.runEvents).toEqual([])
      expect(stored?.alertEvents).toEqual([])
      expect(stored?.enabled).toBe(false)
      expect(stored?.secretSealed).toBe('new')
      expect(stored?.updatedAt).toBe(2)
    })

    it('returns null for an unregistered workspace and deletes idempotently', async () => {
      const repo = makeRepo()
      const ws = nextWorkspace()
      expect(await repo.get(ws)).toBeNull()

      // Deleting an absent row is a no-op, not an error — the management route is idempotent.
      await repo.delete(ws)

      await repo.put({
        workspaceId: ws,
        url: 'https://example.test/hook',
        types: [],
        runEvents: [],
        alertEvents: [],
        enabled: true,
        secretSealed: null,
        updatedAt: 1,
      })
      expect(await repo.get(ws)).not.toBeNull()
      await repo.delete(ws)
      expect(await repo.get(ws)).toBeNull()
    })
  })
}
