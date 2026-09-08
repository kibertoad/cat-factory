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

    it('lists every open card on one block, newest first, and nothing from another', async () => {
      const repo = makeRepo()
      const { ws } = ids()
      // Two DIFFERENT types on the target block: the caller asks whether ANY card points at it,
      // so a by-type read would be the wrong answer here.
      await repo.upsert(
        ws,
        notification({ id: `${ws}-old`, type: 'merge_review', blockId: 'blk-1', createdAt: 10 }),
      )
      await repo.upsert(
        ws,
        notification({
          id: `${ws}-new`,
          type: 'decision_required',
          blockId: 'blk-1',
          executionId: 'exe-1',
          createdAt: 30,
        }),
      )
      // Resolved on the same block, and open on a different one: neither belongs to the answer.
      await repo.upsert(
        ws,
        notification({
          id: `${ws}-done`,
          blockId: 'blk-1',
          status: 'dismissed',
          createdAt: 20,
          resolvedAt: 25,
        }),
      )
      await repo.upsert(ws, notification({ id: `${ws}-other`, blockId: 'blk-2', createdAt: 40 }))
      // BLOCK-LESS and open: the row that separates `block_id = ?` from `block_id = ? OR
      // block_id IS NULL`. A facade that spelled the predicate the second way would hand
      // `ensureWaitingNotification` the workspace-wide `budget_paused` card as "a card already on
      // this block" and suppress the `decision_required` raise for a run parked `blocked`, whose
      // only recovery signal that card is.
      await repo.upsert(
        ws,
        notification({ id: `${ws}-wide`, type: 'budget_paused', createdAt: 50 }),
      )

      const onBlock = await repo.listOpenByBlock(ws, 'blk-1')
      expect(onBlock.map((n) => n.id)).toEqual([`${ws}-new`, `${ws}-old`])
      expect(onBlock[0]?.executionId).toBe('exe-1')
      expect(await repo.listOpenByBlock(ws, 'blk-absent')).toEqual([])
    })

    it('dismisses EVERY open block-less card of a type in one call, and nothing else', async () => {
      const repo = makeRepo()
      const { ws } = ids()
      // Two open block-less cards of the same type: the state two sweeps racing the read-before-
      // write raise leave behind, since NULL block_id is exempt from the open-dedup unique index.
      // Settling only the newest would leave the other open forever, and the escalation sweep
      // would flip it red for a condition that has since cleared.
      await repo.upsert(ws, notification({ id: `${ws}-a`, type: 'platform_health', createdAt: 10 }))
      await repo.upsert(ws, notification({ id: `${ws}-b`, type: 'platform_health', createdAt: 30 }))
      // Untouched: a block-SCOPED card of the type, another type, and an already-resolved row
      // (whose `resolvedAt` must not be restamped).
      await repo.upsert(
        ws,
        notification({ id: `${ws}-scoped`, type: 'platform_health', blockId: 'blk-1' }),
      )
      await repo.upsert(ws, notification({ id: `${ws}-ci`, type: 'ci_failed' }))
      await repo.upsert(
        ws,
        notification({
          id: `${ws}-done`,
          type: 'platform_health',
          status: 'dismissed',
          resolvedAt: 5,
        }),
      )

      const dismissed = await repo.dismissOpenByType(ws, 'platform_health', 777)
      expect(dismissed.map((n) => n.id).sort()).toEqual([`${ws}-a`, `${ws}-b`])
      expect(dismissed.every((n) => n.status === 'dismissed' && n.resolvedAt === 777)).toBe(true)
      expect(await repo.findOpenByType(ws, 'platform_health')).toBeNull()
      expect((await repo.get(ws, `${ws}-scoped`))?.status).toBe('open')
      expect((await repo.get(ws, `${ws}-ci`))?.status).toBe('open')
      expect((await repo.get(ws, `${ws}-done`))?.resolvedAt).toBe(5)
      // Idempotent: nothing open left to settle.
      expect(await repo.dismissOpenByType(ws, 'platform_health', 888)).toEqual([])
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

    it('lists the LATEST block-less card of a type per workspace including resolved ones', async () => {
      const repo = makeRepo()
      const a = ids().ws
      const empty = ids().ws
      await repo.upsert(
        a,
        notification({ id: `${a}-open`, type: 'budget_threshold', createdAt: 1 }),
      )
      // Newer, and DISMISSED. `listOpenByType` must skip it and `listLatestByType` must
      // return it: for an alert whose condition persists all month, the last card the sweep
      // WROTE is the notified-state record, and a human tidying their inbox does not un-notify
      // them. A facade that reused the open-only query here would re-alert every pass.
      await repo.upsert(
        a,
        notification({
          id: `${a}-dismissed`,
          type: 'budget_threshold',
          status: 'dismissed',
          createdAt: 9,
          resolvedAt: 9,
        }),
      )
      // Block-scoped and other-type cards stay excluded, exactly as in the open-only read.
      await repo.upsert(
        a,
        notification({
          id: `${a}-scoped`,
          type: 'budget_threshold',
          blockId: 'blk-1',
          createdAt: 20,
        }),
      )
      await repo.upsert(a, notification({ id: `${a}-other`, type: 'ci_failed', createdAt: 30 }))

      expect((await repo.listLatestByType([a, empty], 'budget_threshold')).get(a)?.id).toBe(
        `${a}-dismissed`,
      )
      expect((await repo.listOpenByType([a], 'budget_threshold')).get(a)?.id).toBe(`${a}-open`)
      expect((await repo.listLatestByType([a, empty], 'budget_threshold')).has(empty)).toBe(false)
      expect((await repo.listLatestByType([], 'budget_threshold')).size).toBe(0)
    })

    it('breaks a same-millisecond tie on id, so the pick is stable across passes', async () => {
      // Both facades reduce to one row per workspace in SQL, so the tiebreak has to be in the
      // ORDER BY rather than in whatever order rows happen to arrive. Without it the caller's
      // "has this already been notified?" answer flaps between two cards minted in the same
      // millisecond, and the spend sweep re-raises (or wrongly withholds) a card on alternate
      // passes for the rest of the period.
      const repo = makeRepo()
      const a = ids().ws
      await repo.upsert(a, notification({ id: `${a}-aaa`, type: 'budget_threshold', createdAt: 7 }))
      await repo.upsert(a, notification({ id: `${a}-zzz`, type: 'budget_threshold', createdAt: 7 }))
      for (let pass = 0; pass < 3; pass += 1) {
        expect((await repo.listLatestByType([a], 'budget_threshold')).get(a)?.id).toBe(`${a}-zzz`)
      }
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
