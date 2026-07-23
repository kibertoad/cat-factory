import type { WorkspaceSettings, WorkspaceSettingsRepository } from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the per-workspace runtime-settings store. The service that reads
// these (the notification-escalation sweep + the settings panel) is runtime-neutral, but each
// facade persists them in its own store (D1 on Cloudflare, Postgres via Drizzle on Node). This
// suite drives the SAME upsert → get → BATCHED listByWorkspaceIds assertions through whichever
// real repository a runtime hands it, so a column mapped differently or the batch `IN` filter
// built differently fails a test instead of shipping. The batch read is the sweep's N+1 fix
// (item 8), so its parity is the point.

function settings(overrides: Partial<WorkspaceSettings>): WorkspaceSettings {
  return { ...DEFAULT_WORKSPACE_SETTINGS, ...overrides }
}

/**
 * Assert a runtime's {@link WorkspaceSettingsRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; workspace ids are unique per run so
 * the shared database stays isolated between cases.
 */
export function defineWorkspaceSettingsSuite(
  name: string,
  makeRepo: () => WorkspaceSettingsRepository,
): void {
  describe(`[${name}] workspace settings repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { a: `ws-a-${tag}`, b: `ws-b-${tag}`, c: `ws-c-${tag}` }
    }

    it('round-trips a settings row through upsert → get', async () => {
      const repo = makeRepo()
      const { a } = ids()
      expect(await repo.get(a)).toBeNull()

      await repo.upsert(
        a,
        settings({
          waitingEscalationMinutes: 45,
          taskLimitMode: 'per_type',
          taskLimitPerType: { feature: 2 },
          storeAgentContext: false,
          kaizenEnabled: false,
          reviewFrictionMode: 'enforce',
          reviewFrictionWarnCount: 5,
          reviewFrictionBlockCount: 8,
          reviewFrictionBlockStuckMinutes: 1440,
          spendCurrency: 'EUR',
          spendMonthlyLimit: 12.5,
        }),
      )

      expect(await repo.get(a)).toMatchObject({
        waitingEscalationMinutes: 45,
        taskLimitMode: 'per_type',
        taskLimitPerType: { feature: 2 },
        storeAgentContext: false,
        kaizenEnabled: false,
        reviewFrictionMode: 'enforce',
        reviewFrictionWarnCount: 5,
        reviewFrictionBlockCount: 8,
        reviewFrictionBlockStuckMinutes: 1440,
        spendCurrency: 'EUR',
        spendMonthlyLimit: 12.5,
      })
    })

    it('batch-reads only the persisted rows, keyed by workspace id', async () => {
      const repo = makeRepo()
      const { a, b, c } = ids()
      await repo.upsert(a, settings({ waitingEscalationMinutes: 10 }))
      await repo.upsert(b, settings({ waitingEscalationMinutes: 20 }))
      // `c` is intentionally never persisted — it must be ABSENT from the map (the caller seeds
      // the default), never a null/undefined entry.

      const map = await repo.listByWorkspaceIds([a, b, c])
      expect(map.get(a)?.waitingEscalationMinutes).toBe(10)
      expect(map.get(b)?.waitingEscalationMinutes).toBe(20)
      expect(map.has(c)).toBe(false)
      expect(map.size).toBe(2)
    })

    it('returns an empty map for an empty id list (no all-rows scan)', async () => {
      const repo = makeRepo()
      const { a } = ids()
      await repo.upsert(a, settings({ waitingEscalationMinutes: 30 }))

      const map = await repo.listByWorkspaceIds([])
      expect(map.size).toBe(0)
    })
  })
}
