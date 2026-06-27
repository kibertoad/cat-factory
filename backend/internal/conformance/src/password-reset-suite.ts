import type { PasswordResetTokenRecord, PasswordResetTokenRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the password-reset token store (the "forgot my password"
// flow). The service that writes these is runtime-neutral, but each facade persists
// them in its own store (D1 on Cloudflare, Postgres via Drizzle on Node). This suite
// drives the SAME create → find-by-hash → supersede → consume → prune assertions
// through whichever real repository a runtime hands it, so a column mapped differently
// or a filter built differently fails a test instead of shipping.

function record(
  overrides: Partial<PasswordResetTokenRecord> & Pick<PasswordResetTokenRecord, 'id'>,
): PasswordResetTokenRecord {
  return {
    userId: 'usr',
    tokenHash: `hash-${overrides.id}`,
    status: 'pending',
    expiresAt: 10_000,
    createdAt: 1,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link PasswordResetTokenRepository} behaves identically to the
 * others. `makeRepo` returns a repo over the runtime's real store; ids/users are unique
 * per run so the shared database stays isolated between cases.
 */
export function definePasswordResetTokenSuite(
  name: string,
  makeRepo: () => PasswordResetTokenRepository,
): void {
  describe(`[${name}] password reset token repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { u: `usr-${tag}`, a: `prt-a-${tag}`, b: `prt-b-${tag}` }
    }

    it('creates a token and resolves it by hash', async () => {
      const repo = makeRepo()
      const { u, a } = ids()
      await repo.create(record({ id: a, userId: u, tokenHash: `h-${a}` }))

      const found = await repo.findByTokenHash(`h-${a}`)
      expect(found).toMatchObject({ id: a, userId: u, status: 'pending', expiresAt: 10_000 })
      expect(await repo.findByTokenHash('nonexistent')).toBeNull()
    })

    it('lists only pending tokens for a user and supersedes via setStatus', async () => {
      const repo = makeRepo()
      const { u, a, b } = ids()
      await repo.create(record({ id: a, userId: u, tokenHash: `h-${a}`, createdAt: 1 }))
      await repo.create(record({ id: b, userId: u, tokenHash: `h-${b}`, createdAt: 2 }))

      // Newest-first, both pending.
      expect((await repo.listPendingByUser(u)).map((r) => r.id)).toEqual([b, a])

      await repo.setStatus(a, 'used')
      const stillPending = await repo.listPendingByUser(u)
      expect(stillPending.map((r) => r.id)).toEqual([b])
      // A consumed token is still resolvable by hash, but no longer 'pending'.
      expect((await repo.findByTokenHash(`h-${a}`))?.status).toBe('used')
    })

    it('consume is atomic single-use: only the first call wins', async () => {
      const repo = makeRepo()
      const { u, a } = ids()
      await repo.create(record({ id: a, userId: u, tokenHash: `h-${a}` }))

      expect(await repo.consume(a)).toBe(true)
      // A second consume (the concurrent-redemption / token-reuse case) loses.
      expect(await repo.consume(a)).toBe(false)
      expect((await repo.findByTokenHash(`h-${a}`))?.status).toBe('used')
      // Consuming an unknown id is a no-op that reports false.
      expect(await repo.consume(`missing-${a}`)).toBe(false)
    })

    it('prunes only expired tokens', async () => {
      const repo = makeRepo()
      const { u, a, b } = ids()
      await repo.create(record({ id: a, userId: u, tokenHash: `h-${a}`, expiresAt: 100 }))
      await repo.create(record({ id: b, userId: u, tokenHash: `h-${b}`, expiresAt: 5_000 }))

      const removed = await repo.deleteExpired(1_000)
      expect(removed).toBe(1)
      expect(await repo.findByTokenHash(`h-${a}`)).toBeNull()
      expect(await repo.findByTokenHash(`h-${b}`)).not.toBeNull()
    })
  })
}
