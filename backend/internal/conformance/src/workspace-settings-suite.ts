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
          inputGateMode: 'advisory',
          reviewFrictionMode: 'enforce',
          reviewFrictionWarnCount: 5,
          reviewFrictionBlockCount: 8,
          reviewFrictionBlockStuckMinutes: 1440,
          spendCurrency: 'EUR',
          spendMonthlyLimit: 12.5,
          defaultProvisionType: 'custom',
          defaultProvisionManifestId: 'acme-preview',
          doneLaneMaxItems: 75,
          doneLaneRetentionDays: 90,
          metadata: { gameId: 'zork', region: 'eu' },
        }),
      )

      expect(await repo.get(a)).toMatchObject({
        waitingEscalationMinutes: 45,
        taskLimitMode: 'per_type',
        taskLimitPerType: { feature: 2 },
        storeAgentContext: false,
        kaizenEnabled: false,
        inputGateMode: 'advisory',
        reviewFrictionMode: 'enforce',
        reviewFrictionWarnCount: 5,
        reviewFrictionBlockCount: 8,
        reviewFrictionBlockStuckMinutes: 1440,
        spendCurrency: 'EUR',
        spendMonthlyLimit: 12.5,
        defaultProvisionType: 'custom',
        defaultProvisionManifestId: 'acme-preview',
        doneLaneMaxItems: 75,
        doneLaneRetentionDays: 90,
        metadata: { gameId: 'zork', region: 'eu' },
      })
    })

    // The Done swimlane's two caps have a falsy and a null value that both MEAN something,
    // and either store coercing one would change what the board renders: `0` is "count the
    // finished tasks, show none" (not "fall back to the default 20"), and a null retention
    // is "no age cap" (not "14 days"). A `||` in a mapper is all it takes to lose either.
    it('round-trips a zero Done-lane cap and a null retention without coercing them', async () => {
      const repo = makeRepo()
      const { a } = ids()
      await repo.upsert(a, settings({ doneLaneMaxItems: 0, doneLaneRetentionDays: null }))

      const stored = await repo.get(a)
      expect(stored?.doneLaneMaxItems).toBe(0)
      expect(stored?.doneLaneRetentionDays).toBeNull()
      // The batched read maps the same way as the point read.
      const batched = (await repo.listByWorkspaceIds([a])).get(a)
      expect(batched?.doneLaneMaxItems).toBe(0)
      expect(batched?.doneLaneRetentionDays).toBeNull()
    })

    // The custom-metadata bag is a JSON column on both stores, and an EMPTY one is the common
    // case (nobody has filled a field in). It must read back as `{}` — a null would make every
    // reader, above all an external-tool URL resolver indexing `metadata.gameId`, need a guard
    // the total settings type says it doesn't.
    it('reads an empty metadata bag back as an empty object on both stores', async () => {
      const repo = makeRepo()
      const { a } = ids()
      await repo.upsert(a, settings({ waitingEscalationMinutes: 60 }))

      expect((await repo.get(a))?.metadata).toEqual({})
      expect((await repo.listByWorkspaceIds([a])).get(a)?.metadata).toEqual({})
    })

    // The default-provisioning pair is NULLABLE on purpose: null means "the operator never
    // chose" (what the SPA's setup banner nags about), which must survive the round trip as
    // null rather than being coerced to `infraless` or to an empty string by either store —
    // either would silence the banner on a board that has decided nothing.
    it('round-trips an unset default provisioning choice as null on both stores', async () => {
      const repo = makeRepo()
      const { a } = ids()
      await repo.upsert(a, settings({ waitingEscalationMinutes: 60 }))

      const stored = await repo.get(a)
      expect(stored?.defaultProvisionType).toBeNull()
      expect(stored?.defaultProvisionManifestId).toBeNull()
    })

    // `infraless` is a real recorded decision ("services stand up no environment"), so it must
    // read back as itself and NOT collapse into the unset state.
    it('keeps an explicit infraless default distinct from an unset one', async () => {
      const repo = makeRepo()
      const { a } = ids()
      await repo.upsert(a, settings({ defaultProvisionType: 'infraless' }))

      const stored = await repo.get(a)
      expect(stored?.defaultProvisionType).toBe('infraless')
      expect(stored?.defaultProvisionManifestId).toBeNull()
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
