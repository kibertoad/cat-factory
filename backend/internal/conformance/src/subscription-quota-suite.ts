import type { SubscriptionQuotaCycleRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the subscription quota-cycle store (usage-and-quota-tracking,
// Part B). The provider that folds a run's tokens into rolling windows is runtime-neutral,
// but each facade persists the counters in its own store (D1 on Cloudflare, Drizzle/
// Postgres on Node). This suite drives the SAME windowed-UPSERT → list → prune assertions
// through whichever real repository a runtime hands it, so a column mapped differently or
// the window-reset logic diverging fails a test instead of shipping.

const FIVE_H = 5 * 60 * 60 * 1000
const WEEK = 7 * 24 * 60 * 60 * 1000

/**
 * Assert a runtime's {@link SubscriptionQuotaCycleRepository} behaves identically to the
 * others. `makeRepo` returns a repo over the runtime's real store; scope ids are unique
 * per case so the shared database stays isolated between cases.
 */
export function defineSubscriptionQuotaSuite(
  name: string,
  makeRepo: () => SubscriptionQuotaCycleRepository,
): void {
  describe(`[${name}] subscription quota-cycle repository parity`, () => {
    let seq = 0
    const scopeId = () => {
      seq += 1
      return `${name}-scope-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    it('anchors a window on first use and accumulates within it', async () => {
      const repo = makeRepo()
      const sid = scopeId()
      await repo.recordUsage(
        { id: `${sid}-a`, scope: 'pooled', scopeId: sid, vendor: 'kimi', windowKind: '5h' },
        { inputTokens: 100, outputTokens: 50 },
        1_000,
        FIVE_H,
      )
      await repo.recordUsage(
        { id: `${sid}-b`, scope: 'pooled', scopeId: sid, vendor: 'kimi', windowKind: '5h' },
        { inputTokens: 40, outputTokens: 10 },
        1_000 + 60_000,
        FIVE_H,
      )
      const rows = await repo.listByScopeVendor('pooled', sid, 'kimi')
      expect(rows).toHaveLength(1)
      const row = rows[0]!
      // Second run folded into the still-active window: counters summed, anchor unchanged.
      expect(row.inputTokens).toBe(140)
      expect(row.outputTokens).toBe(60)
      expect(row.requestCount).toBe(2)
      expect(row.windowStartedAt).toBe(1_000)
      expect(row.windowKind).toBe('5h')
      expect(row.vendor).toBe('kimi')
    })

    it('resets the window (re-anchors + restarts counters) once it ages out', async () => {
      const repo = makeRepo()
      const sid = scopeId()
      await repo.recordUsage(
        { id: `${sid}-a`, scope: 'user', scopeId: sid, vendor: 'claude', windowKind: '5h' },
        { inputTokens: 1_000, outputTokens: 1_000 },
        1_000,
        FIVE_H,
      )
      // A run past the window boundary resets the counters to just this run.
      await repo.recordUsage(
        { id: `${sid}-b`, scope: 'user', scopeId: sid, vendor: 'claude', windowKind: '5h' },
        { inputTokens: 7, outputTokens: 3 },
        1_000 + FIVE_H + 1,
        FIVE_H,
      )
      const row = (await repo.listByScopeVendor('user', sid, 'claude'))[0]!
      expect(row.inputTokens).toBe(7)
      expect(row.outputTokens).toBe(3)
      expect(row.requestCount).toBe(1)
      expect(row.windowStartedAt).toBe(1_000 + FIVE_H + 1)
    })

    it('keeps each window kind as its own independently-resetting row', async () => {
      const repo = makeRepo()
      const sid = scopeId()
      // Same usage into both windows.
      for (const [id, kind, ms] of [
        [`${sid}-5h`, '5h', FIVE_H],
        [`${sid}-wk`, 'weekly', WEEK],
      ] as const) {
        await repo.recordUsage(
          { id, scope: 'pooled', scopeId: sid, vendor: 'deepseek', windowKind: kind },
          { inputTokens: 200, outputTokens: 100 },
          1_000,
          ms,
        )
      }
      // A run 6h later: the 5h window has reset, the weekly one accumulates.
      const later = 1_000 + 6 * 60 * 60 * 1000
      await repo.recordUsage(
        { id: `${sid}-5h2`, scope: 'pooled', scopeId: sid, vendor: 'deepseek', windowKind: '5h' },
        { inputTokens: 5, outputTokens: 5 },
        later,
        FIVE_H,
      )
      await repo.recordUsage(
        {
          id: `${sid}-wk2`,
          scope: 'pooled',
          scopeId: sid,
          vendor: 'deepseek',
          windowKind: 'weekly',
        },
        { inputTokens: 5, outputTokens: 5 },
        later,
        WEEK,
      )
      const rows = await repo.listByScopeVendor('pooled', sid, 'deepseek')
      const byKind = Object.fromEntries(rows.map((r) => [r.windowKind, r]))
      expect(byKind['5h']!.inputTokens).toBe(5) // reset
      expect(byKind['weekly']!.inputTokens).toBe(205) // accumulated
    })

    it('scopes reads by (scope, scopeId, vendor)', async () => {
      const repo = makeRepo()
      const sid = scopeId()
      const other = scopeId()
      await repo.recordUsage(
        { id: `${sid}-k`, scope: 'pooled', scopeId: sid, vendor: 'kimi', windowKind: '5h' },
        { inputTokens: 1, outputTokens: 1 },
        1,
        FIVE_H,
      )
      // Same scopeId, different vendor — must not bleed into the kimi read.
      await repo.recordUsage(
        { id: `${sid}-d`, scope: 'pooled', scopeId: sid, vendor: 'deepseek', windowKind: '5h' },
        { inputTokens: 1, outputTokens: 1 },
        1,
        FIVE_H,
      )
      // Different scope kind, same id string — must not bleed either.
      await repo.recordUsage(
        { id: `${other}-u`, scope: 'user', scopeId: sid, vendor: 'kimi', windowKind: '5h' },
        { inputTokens: 1, outputTokens: 1 },
        1,
        FIVE_H,
      )
      expect((await repo.listByScopeVendor('pooled', sid, 'kimi')).map((r) => r.vendor)).toEqual([
        'kimi',
      ])
      expect(await repo.listByScopeVendor('pooled', other, 'kimi')).toHaveLength(0)
    })

    it('prunes cycles whose window started before a cutoff', async () => {
      const repo = makeRepo()
      const sid = scopeId()
      await repo.recordUsage(
        { id: `${sid}-old`, scope: 'user', scopeId: sid, vendor: 'codex', windowKind: '5h' },
        { inputTokens: 1, outputTokens: 1 },
        1_000,
        FIVE_H,
      )
      await repo.recordUsage(
        { id: `${sid}-new`, scope: 'user', scopeId: sid, vendor: 'codex', windowKind: 'weekly' },
        { inputTokens: 1, outputTokens: 1 },
        9_000_000,
        WEEK,
      )
      // Global (table-wide) prune, so its count can include other cases' rows in the shared
      // DB — assert the scoped, deterministic outcome instead.
      const removed = await repo.deleteOlderThan(2_000)
      expect(removed).toBeGreaterThanOrEqual(1)
      expect((await repo.listByScopeVendor('user', sid, 'codex')).map((r) => r.windowKind)).toEqual(
        ['weekly'],
      )
    })
  })
}
