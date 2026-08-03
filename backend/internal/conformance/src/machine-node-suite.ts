import type { MachineNodeMint, MachineNodeRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the machine-node roster + revocation tombstones (SEC-5).
// The mint/gate/revoke logic is runtime-neutral, but each facade persists the roster in
// its own store (D1 on Cloudflare, Postgres via Drizzle on Node). This suite drives the
// SAME record-mint → re-mint fold → revoke → isRevoked → prune assertions through
// whichever real repository a runtime hands it, so a column mapped differently or an
// upsert folding differently fails a test instead of shipping.

function mint(
  overrides: Partial<MachineNodeMint> & Pick<MachineNodeMint, 'nodeId'>,
): MachineNodeMint {
  return {
    userId: 'usr',
    accountIds: ['acc-1'],
    mintedAt: 1_000,
    expiresAt: 10_000,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link MachineNodeRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; ids/users are unique per run
 * so the shared database stays isolated between cases.
 */
export function defineMachineNodeSuite(name: string, makeRepo: () => MachineNodeRepository): void {
  describe(`[${name}] machine-node repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { u: `usr-${tag}`, a: `node-a-${tag}`, b: `node-b-${tag}` }
    }

    it('records a mint and folds a re-mint without losing the longer expiry', async () => {
      const repo = makeRepo()
      const { u, a } = ids()
      await repo.recordMint(mint({ nodeId: a, userId: u, mintedAt: 1_000, expiresAt: 10_000 }))

      const created = await repo.get(a)
      expect(created).toMatchObject({
        nodeId: a,
        userId: u,
        accountIds: ['acc-1'],
        createdAt: 1_000,
        lastMintedAt: 1_000,
        expiresAt: 10_000,
        revokedAt: null,
        revokedByUserId: null,
      })

      // A later re-mint with a SHORTER exp refreshes the mint columns but must not make
      // the roster forget the longer outstanding token.
      await repo.recordMint(
        mint({ nodeId: a, userId: u, accountIds: ['acc-2'], mintedAt: 2_000, expiresAt: 5_000 }),
      )
      const refolded = await repo.get(a)
      expect(refolded).toMatchObject({
        accountIds: ['acc-2'],
        createdAt: 1_000, // first mint's
        lastMintedAt: 2_000,
        expiresAt: 10_000, // the longer exp survives
      })

      expect(await repo.get(`missing-${a}`)).toBeNull()
    })

    it('lists a user’s nodes newest-mint first', async () => {
      const repo = makeRepo()
      const { u, a, b } = ids()
      await repo.recordMint(mint({ nodeId: a, userId: u, mintedAt: 1_000 }))
      await repo.recordMint(mint({ nodeId: b, userId: u, mintedAt: 2_000 }))

      expect((await repo.listByUser(u)).map((r) => r.nodeId)).toEqual([b, a])
      expect(await repo.listByUser(`other-${u}`)).toEqual([])
    })

    it('revoke is an idempotent tombstone: first write wins, unknown node reports false', async () => {
      const repo = makeRepo()
      const { u, a } = ids()
      await repo.recordMint(mint({ nodeId: a, userId: u }))
      expect(await repo.isRevoked(a)).toBe(false)

      expect(await repo.revoke(a, 3_000, u)).toBe(true)
      expect(await repo.isRevoked(a)).toBe(true)

      // Re-revoking succeeds but keeps the ORIGINAL tombstone (timestamp + actor).
      expect(await repo.revoke(a, 9_999, `late-${u}`)).toBe(true)
      expect(await repo.get(a)).toMatchObject({ revokedAt: 3_000, revokedByUserId: u })

      // Unknown node: nothing to tombstone.
      expect(await repo.revoke(`missing-${a}`, 3_000, u)).toBe(false)
      // An unknown node is NOT revoked (the gate only refuses explicit tombstones).
      expect(await repo.isRevoked(`missing-${a}`)).toBe(false)
    })

    it('prunes only rows past their expiry, revoked or not', async () => {
      const repo = makeRepo()
      const { u, a, b } = ids()
      await repo.recordMint(mint({ nodeId: a, userId: u, expiresAt: 100 }))
      await repo.recordMint(mint({ nodeId: b, userId: u, expiresAt: 5_000 }))
      await repo.revoke(a, 50, u)

      const removed = await repo.deleteExpired(1_000)
      expect(removed).toBe(1)
      expect(await repo.get(a)).toBeNull()
      expect(await repo.get(b)).not.toBeNull()
    })
  })
}
