import type { SealedSecretInventory } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the sealed-secret inventory (ADR 0026 D6.2/D6.3). The drift sweep +
// the drop remediation are runtime-neutral, but each facade enumerates + drops the sealed
// credentials over its own store — D1 on Cloudflare, Drizzle/Postgres on Node. This suite drives
// the SAME listSealed → drop assertions through whichever real inventory a runtime hands it (with
// seed helpers the runtime implements against its schema), so a source that maps a column
// differently or a drop that targets the wrong row fails a test instead of shipping.

/** The minimal row a runtime seeds so the inventory can enumerate it. */
export interface SealedSecretInventoryHarness {
  inventory: SealedSecretInventory
  /** Insert an `environment_connections` row (the runtime fills its schema's other NOT NULLs). */
  seedEnvConnection(row: {
    workspaceId: string
    provisionType: string
    manifestId: string
    secretsCipher: string
    createdAt: number
  }): Promise<void>
  /** Insert an `observability_connections` row. */
  seedObsConnection(row: {
    workspaceId: string
    provider: string
    credentials: string
    updatedAt: number
  }): Promise<void>
}

export function defineSealedSecretInventorySuite(
  name: string,
  make: () => SealedSecretInventoryHarness,
): void {
  describe(`[${name}] sealed-secret inventory parity`, () => {
    let seq = 0
    const uniq = () => {
      seq += 1
      return `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    it('enumerates env + observability sealed secrets with the right shape', async () => {
      const h = make()
      const ws = `ws-${uniq()}`
      await h.seedEnvConnection({
        workspaceId: ws,
        provisionType: 'kubernetes',
        manifestId: '',
        secretsCipher: 'v1.env.sealed',
        createdAt: 111,
      })
      await h.seedObsConnection({
        workspaceId: ws,
        provider: 'datadog',
        credentials: 'v1.obs.sealed',
        updatedAt: 222,
      })

      const refs = await h.inventory.listSealed()
      const env = refs.find((r) => r.source === 'environment_connection' && r.workspaceId === ws)
      const obs = refs.find((r) => r.source === 'observability_connection' && r.workspaceId === ws)

      expect(env).toMatchObject({
        id: `${ws}|kubernetes|`,
        workspaceId: ws,
        info: 'cat-factory:environments',
        envelope: 'v1.env.sealed',
        sealedAt: 111,
      })
      expect(obs).toMatchObject({
        id: ws,
        workspaceId: ws,
        info: 'cat-factory:observability',
        envelope: 'v1.obs.sealed',
        sealedAt: 222,
      })
    })

    it('drops an env connection (soft-delete) so it leaves the inventory; second drop is a no-op', async () => {
      const h = make()
      const ws = `ws-${uniq()}`
      await h.seedEnvConnection({
        workspaceId: ws,
        provisionType: 'kubernetes',
        manifestId: '',
        secretsCipher: 'v1.env.sealed',
        createdAt: 1,
      })
      const id = `${ws}|kubernetes|`

      expect(await h.inventory.drop({ source: 'environment_connection', id })).toEqual({
        dropped: true,
      })
      const after = await h.inventory.listSealed()
      expect(
        after.find((r) => r.source === 'environment_connection' && r.workspaceId === ws),
      ).toBeUndefined()
      // Idempotent: dropping an already-gone secret reports false.
      expect(await h.inventory.drop({ source: 'environment_connection', id })).toEqual({
        dropped: false,
      })
    })

    it('round-trips an env id whose manifestId contains the `|` delimiter', async () => {
      // The composite env id is `workspaceId|provisionType|manifestId`; a manifestId that itself
      // contains `|` must survive listSealed → drop, or the drop silently misses the row. Seed one,
      // read its id back from the inventory, and drop by exactly that id.
      const h = make()
      const ws = `ws-${uniq()}`
      await h.seedEnvConnection({
        workspaceId: ws,
        provisionType: 'kubernetes',
        manifestId: 'multi|part|manifest',
        secretsCipher: 'v1.env.sealed',
        createdAt: 1,
      })
      const listed = await h.inventory.listSealed()
      const ref = listed.find(
        (r) => r.source === 'environment_connection' && r.workspaceId === ws,
      )
      expect(ref?.id).toBe(`${ws}|kubernetes|multi|part|manifest`)

      expect(await h.inventory.drop({ source: 'environment_connection', id: ref!.id })).toEqual({
        dropped: true,
      })
      const after = await h.inventory.listSealed()
      expect(
        after.find((r) => r.source === 'environment_connection' && r.workspaceId === ws),
      ).toBeUndefined()
    })

    it('drops an observability connection so it leaves the inventory', async () => {
      const h = make()
      const ws = `ws-${uniq()}`
      await h.seedObsConnection({
        workspaceId: ws,
        provider: 'datadog',
        credentials: 'v1.obs.sealed',
        updatedAt: 1,
      })
      expect(await h.inventory.drop({ source: 'observability_connection', id: ws })).toEqual({
        dropped: true,
      })
      const after = await h.inventory.listSealed()
      expect(
        after.find((r) => r.source === 'observability_connection' && r.workspaceId === ws),
      ).toBeUndefined()
    })

    it('ignores an unknown source', async () => {
      const h = make()
      expect(await h.inventory.drop({ source: 'nope', id: 'x' })).toEqual({ dropped: false })
    })
  })
}
