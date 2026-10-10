import type {
  ApiKeyProvider,
  ProviderApiKeyRecord,
  ProviderApiKeyRepository,
  ProviderSubscriptionTokenRecord,
  ProviderSubscriptionTokenRepository,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import { chooseToken } from '@cat-factory/integrations'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the two credential pools' enable/disable + pinned-default
// behaviour. A pool can hold several credentials "for the same thing" (a scope+provider /
// a workspace+vendor); an operator can take one out of rotation (`enabled = 0`) or pin one
// as the preferred credential (`is_default = 1`). The SELECTION lives in runtime-specific
// SQL — the API-key pool's atomic `leaseLeastUsed` (D1 / Drizzle / node:sqlite) and the
// subscription pool's `listByVendor` feeding the pure `chooseToken` — so this suite drives
// the SAME add → flag → lease/list assertions through whichever real repositories a runtime
// hands it, and a facade whose `enabled`/`is_default` filter or ordering diverges fails a
// test instead of shipping.

const WINDOW = 5 * 60 * 60 * 1000

export interface CredentialPoolRepos {
  makeApiKeyRepo: () => ProviderApiKeyRepository
  makeSubscriptionRepo: () => ProviderSubscriptionTokenRepository
}

function apiKeyRecord(
  over: Partial<ProviderApiKeyRecord> & { id: string; scopeId: string },
): ProviderApiKeyRecord {
  return {
    scope: 'workspace',
    provider: 'openai',
    label: over.id,
    keyCipher: `cipher-${over.id}`,
    createdAt: 1000,
    lastUsedAt: null,
    windowStartedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    enabled: true,
    isDefault: false,
    deletedAt: null,
    ...over,
  }
}

function subRecord(
  over: Partial<ProviderSubscriptionTokenRecord> & { id: string; workspaceId: string },
): ProviderSubscriptionTokenRecord {
  return {
    vendor: 'kimi',
    label: over.id,
    tokenCipher: `cipher-${over.id}`,
    createdAt: 1000,
    lastUsedAt: null,
    windowStartedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    enabled: true,
    isDefault: false,
    deletedAt: null,
    ...over,
  }
}

/**
 * Assert a runtime's credential-pool repositories honour `enabled` / `is_default` identically
 * to the others. Ids are unique per case so the shared database stays isolated between cases.
 */
export function defineCredentialPoolSuite(name: string, repos: CredentialPoolRepos): void {
  describe(`[${name}] credential pools: enable/disable + default`, () => {
    let seq = 0
    const uid = (label: string) => {
      seq += 1
      return `${name}-${label}-${seq}-${Math.floor(Math.random() * 1e9)}`
    }
    const provider: ApiKeyProvider = 'openai'
    const vendor: SubscriptionVendor = 'kimi'

    it('api-key pool: a disabled key is skipped by lease + availability but stays listed', async () => {
      const repo = repos.makeApiKeyRepo()
      const ws = uid('ws')
      const scopes = [{ scope: 'workspace' as const, scopeId: ws }]
      const a = uid('a')
      const b = uid('b')
      await repo.add(apiKeyRecord({ id: a, scopeId: ws, createdAt: 1 }))
      await repo.add(apiKeyRecord({ id: b, scopeId: ws, createdAt: 2 }))

      // Disable `a`: it stays in the management list but never leases and doesn't count.
      await repo.setEnabled('workspace', ws, a, false)
      const listed = await repo.listByScope('workspace', ws, provider)
      expect(listed.map((r) => r.id).sort()).toEqual([a, b].sort())
      expect(listed.find((r) => r.id === a)!.enabled).toBe(false)
      expect((await repo.listForPool(scopes, provider)).map((r) => r.id)).toEqual([b])
      expect(await repo.listConfiguredProviders(scopes)).toEqual([provider])

      for (let i = 0; i < 4; i++) {
        const leased = await repo.leaseLeastUsed(scopes, provider, 1000, WINDOW)
        expect(leased?.id).toBe(b)
      }

      // Disable the last enabled key: the provider is now unconfigured and lease returns null.
      await repo.setEnabled('workspace', ws, b, false)
      expect(await repo.listForPool(scopes, provider)).toEqual([])
      expect(await repo.listConfiguredProviders(scopes)).toEqual([])
      expect(await repo.leaseLeastUsed(scopes, provider, 1000, WINDOW)).toBeNull()
    })

    it('api-key pool: a pinned default wins the lease, moves, and clears — at most one per group', async () => {
      const repo = repos.makeApiKeyRepo()
      const ws = uid('ws')
      const scopes = [{ scope: 'workspace' as const, scopeId: ws }]
      const a = uid('a')
      const b = uid('b')
      // `a` is heavily loaded, so plain rotation would prefer `b`.
      await repo.add(
        apiKeyRecord({
          id: a,
          scopeId: ws,
          createdAt: 1,
          windowStartedAt: 1000,
          inputTokens: 900,
          outputTokens: 100,
        }),
      )
      await repo.add(apiKeyRecord({ id: b, scopeId: ws, createdAt: 2 }))

      await repo.setDefault('workspace', ws, provider, a)
      expect((await repo.leaseLeastUsed(scopes, provider, 2000, WINDOW))?.id).toBe(a)

      // Pinning `b` clears `a`'s flag (single default per scope+provider).
      await repo.setDefault('workspace', ws, provider, b)
      const rows = await repo.listByScope('workspace', ws, provider)
      expect(rows.filter((r) => r.isDefault).map((r) => r.id)).toEqual([b])
      expect((await repo.leaseLeastUsed(scopes, provider, 2000, WINDOW))?.id).toBe(b)

      // A DISABLED default is ignored — lease falls back to rotation (the least-loaded `b`).
      await repo.setDefault('workspace', ws, provider, a)
      await repo.setEnabled('workspace', ws, a, false)
      expect((await repo.leaseLeastUsed(scopes, provider, 2000, WINDOW))?.id).toBe(b)

      // Clearing the default with a null id reverts fully to rotation.
      await repo.setDefault('workspace', ws, provider, null)
      expect((await repo.listByScope('workspace', ws, provider)).some((r) => r.isDefault)).toBe(
        false,
      )
    })

    it('subscription pool: disabled tokens are skipped and a default is preferred (via chooseToken)', async () => {
      const repo = repos.makeSubscriptionRepo()
      const ws = uid('ws')
      const busy = uid('busy')
      const idle = uid('idle')
      await repo.add(
        subRecord({
          id: busy,
          workspaceId: ws,
          createdAt: 1,
          windowStartedAt: 1000,
          inputTokens: 900,
          outputTokens: 100,
        }),
      )
      await repo.add(subRecord({ id: idle, workspaceId: ws, createdAt: 2 }))

      // Plain rotation prefers the idle token.
      let rows = await repo.listByVendor(ws, vendor)
      expect(chooseToken(rows, 2000, WINDOW)?.id).toBe(idle)

      // Pin the busy one as default: it wins despite its load.
      await repo.setDefault(ws, vendor, busy)
      rows = await repo.listByVendor(ws, vendor)
      expect(chooseToken(rows, 2000, WINDOW)?.id).toBe(busy)

      // Disable the busy default: it is listed but ignored, so rotation picks the idle token.
      await repo.setEnabled(ws, busy, false)
      rows = await repo.listByVendor(ws, vendor)
      expect(rows.map((r) => r.id).sort()).toEqual([busy, idle].sort())
      expect(chooseToken(rows, 2000, WINDOW)?.id).toBe(idle)

      // Disabling every token leaves nothing to choose.
      await repo.setEnabled(ws, idle, false)
      rows = await repo.listByVendor(ws, vendor)
      expect(chooseToken(rows, 2000, WINDOW)).toBeNull()
    })

    it('subscription pool: listByWorkspace spans vendors and agrees with listByVendor', async () => {
      // The batch read the capability resolver folds a workspace's whole pool through, so a facade
      // whose cross-vendor filter or tombstone predicate diverges fails here rather than reporting
      // a vendor as unconfigured on one runtime only. Asserted as a RELATION against the per-vendor
      // read this suite already pins, so neither can drift from the other: the union of the parts
      // is the whole, and each part is what the whole says it is.
      const repo = repos.makeSubscriptionRepo()
      const ws = uid('ws')
      const other = uid('other-ws')
      const kimiLive = uid('kimi-live')
      const kimiOff = uid('kimi-off')
      const kimiGone = uid('kimi-gone')
      const deepseek = uid('deepseek')
      await repo.add(subRecord({ id: kimiLive, workspaceId: ws, vendor: 'kimi', createdAt: 1 }))
      await repo.add(subRecord({ id: kimiOff, workspaceId: ws, vendor: 'kimi', createdAt: 2 }))
      await repo.add(subRecord({ id: kimiGone, workspaceId: ws, vendor: 'kimi', createdAt: 3 }))
      await repo.add(subRecord({ id: deepseek, workspaceId: ws, vendor: 'deepseek', createdAt: 4 }))
      // A neighbouring workspace's pool must never leak into the answer.
      await repo.add(subRecord({ id: uid('theirs'), workspaceId: other, vendor: 'kimi' }))
      // Disabled stays LISTED (the caller filters on `enabled`); deleted is a tombstone and does not.
      await repo.setEnabled(ws, kimiOff, false)
      await repo.softDelete(ws, kimiGone, 5000)

      const all = await repo.listByWorkspace(ws)
      expect(all.map((r) => r.id).sort()).toEqual([deepseek, kimiLive, kimiOff].sort())
      expect(all.map((r) => r.id)).toEqual(
        [...all].sort((a, b) => a.createdAt - b.createdAt).map((r) => r.id),
      )
      for (const v of ['kimi', 'deepseek'] as const) {
        const perVendor = await repo.listByVendor(ws, v)
        expect(all.filter((r) => r.vendor === v).map((r) => r.id)).toEqual(
          perVendor.map((r) => r.id),
        )
      }
      // The enabled subset is what a "which vendors are pooled here" read reduces to.
      expect(new Set(all.filter((r) => r.enabled).map((r) => r.vendor))).toEqual(
        new Set(['kimi', 'deepseek']),
      )
    })
  })
}
