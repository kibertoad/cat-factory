import type { Notification, NotificationRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the notifications store (the canonical persistence behind the
// in-app inbox). Each facade persists them in its own store (D1 on Cloudflare, Postgres on
// Node). This suite drives the SAME upsert → listOpen (open-only, newest-first) → retention
// prune assertions through whichever real repository a runtime hands it, so a column mapped
// differently or a prune predicate built differently fails a test instead of shipping. The
// prune is the retention sweep's write for the otherwise-unbounded `notifications` table —
// it must delete only terminal (acted/dismissed) rows past the cutoff and NEVER an open one.

function notification(overrides: Partial<Notification> & Pick<Notification, 'id'>): Notification {
  return {
    type: 'ci_failed',
    status: 'open',
    severity: 'normal',
    blockId: null,
    executionId: null,
    title: 't',
    body: 'b',
    payload: null,
    createdAt: 1,
    resolvedAt: null,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link NotificationRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; ids/workspaces are unique per
 * run so a shared database stays isolated between cases.
 */
export function defineNotificationSuite(
  name: string,
  makeRepo: () => NotificationRepository,
): void {
  describe(`[${name}] notification repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}` }
    }

    it('lists only open notifications for a workspace, newest first', async () => {
      const repo = makeRepo()
      const { ws } = ids()
      await repo.upsert(ws, notification({ id: `${ws}-a`, createdAt: 10 }))
      await repo.upsert(ws, notification({ id: `${ws}-b`, createdAt: 30 }))
      await repo.upsert(
        ws,
        notification({ id: `${ws}-acted`, status: 'acted', createdAt: 20, resolvedAt: 25 }),
      )

      const open = await repo.listOpen(ws)
      expect(open.map((n) => n.id)).toEqual([`${ws}-b`, `${ws}-a`])
    })

    it('finds the open block-less card of a type, ignoring block-scoped + resolved ones', async () => {
      const repo = makeRepo()
      const { ws } = ids()
      // Block-scoped card of the type → never returned by the block-less lookup.
      await repo.upsert(
        ws,
        notification({ id: `${ws}-scoped`, type: 'platform_health', blockId: 'blk-1' }),
      )
      // Resolved block-less card of the type → not open, so ignored.
      await repo.upsert(
        ws,
        notification({
          id: `${ws}-resolved`,
          type: 'platform_health',
          status: 'dismissed',
          resolvedAt: 5,
        }),
      )
      expect(await repo.findOpenByType(ws, 'platform_health')).toBeNull()

      // The open block-less card of the type → returned.
      await repo.upsert(ws, notification({ id: `${ws}-open`, type: 'platform_health' }))
      const found = await repo.findOpenByType(ws, 'platform_health')
      expect(found?.id).toBe(`${ws}-open`)
      // A different type is not matched.
      expect(await repo.findOpenByType(ws, 'ci_failed')).toBeNull()
    })

    it('lists the open block-less card of a type per workspace (batched), newest per workspace', async () => {
      const repo = makeRepo()
      const a = ids().ws
      const b = ids().ws
      const empty = ids().ws // has no card → absent from the result
      // Workspace A: two open block-less cards → the NEWEST wins (matches findOpenByType).
      await repo.upsert(a, notification({ id: `${a}-old`, type: 'platform_health', createdAt: 1 }))
      await repo.upsert(a, notification({ id: `${a}-new`, type: 'platform_health', createdAt: 9 }))
      // Workspace A noise: block-scoped + resolved cards of the type are never returned.
      await repo.upsert(
        a,
        notification({ id: `${a}-scoped`, type: 'platform_health', blockId: 'blk-1' }),
      )
      await repo.upsert(
        a,
        notification({
          id: `${a}-done`,
          type: 'platform_health',
          status: 'dismissed',
          resolvedAt: 5,
        }),
      )
      // Workspace B: one open block-less card.
      await repo.upsert(b, notification({ id: `${b}-open`, type: 'platform_health' }))
      // A card of a DIFFERENT type must not leak in.
      await repo.upsert(b, notification({ id: `${b}-ci`, type: 'ci_failed' }))

      const found = await repo.listOpenByType([a, b, empty], 'platform_health')
      expect(found.get(a)?.id).toBe(`${a}-new`)
      expect(found.get(b)?.id).toBe(`${b}-open`)
      expect(found.has(empty)).toBe(false)
      // Empty input → empty map (no query).
      expect((await repo.listOpenByType([], 'platform_health')).size).toBe(0)
    })

    it('prunes resolved rows past the cutoff, keeping open + fresh-resolved ones', async () => {
      const repo = makeRepo()
      const { ws } = ids()
      // Terminal + old → pruned.
      await repo.upsert(
        ws,
        notification({
          id: `${ws}-old-acted`,
          status: 'acted',
          createdAt: 1_000,
          resolvedAt: 1_000,
        }),
      )
      await repo.upsert(
        ws,
        notification({
          id: `${ws}-old-dismissed`,
          status: 'dismissed',
          createdAt: 1_200,
          resolvedAt: 1_500,
        }),
      )
      // Terminal but fresh → kept.
      await repo.upsert(
        ws,
        notification({
          id: `${ws}-fresh-acted`,
          status: 'acted',
          createdAt: 5_000,
          resolvedAt: 9_000_000,
        }),
      )
      // Open (ancient, unresolved) → the actionable inbox, NEVER pruned.
      await repo.upsert(ws, notification({ id: `${ws}-open`, createdAt: 1, resolvedAt: null }))

      // The prune is global (all workspaces), and a shared test DB may hold sibling
      // rows, so assert on THESE rows via `get` and only bound the count from below.
      const removed = await repo.deleteResolvedOlderThan(2_000)
      expect(removed).toBeGreaterThanOrEqual(2)

      // The open card and the fresh-resolved one survive; both old terminal rows are gone.
      expect(await repo.get(ws, `${ws}-old-acted`)).toBeNull()
      expect(await repo.get(ws, `${ws}-old-dismissed`)).toBeNull()
      expect(await repo.get(ws, `${ws}-fresh-acted`)).not.toBeNull()
      const openRow = await repo.get(ws, `${ws}-open`)
      expect(openRow?.status).toBe('open')
    })

    it('never prunes an open row regardless of age', async () => {
      const repo = makeRepo()
      const { ws } = ids()
      await repo.upsert(ws, notification({ id: `${ws}-ancient-open`, createdAt: 1 }))

      // Even a cutoff far in the future leaves the open card untouched (it's the inbox).
      await repo.deleteResolvedOlderThan(9_000_000_000)
      expect(await repo.get(ws, `${ws}-ancient-open`)).not.toBeNull()
    })
  })
}
