import type { AuthAttemptRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the durable auth-attempt ledger behind the password throttle
// (SEC-4). The throttle logic is runtime-neutral, but each facade persists attempts in
// its own store (D1 on Cloudflare, Postgres via Drizzle on Node). This suite drives the
// SAME record → window count (per key AND per IP) → prune assertions through whichever
// real repository a runtime hands it, so a count filtered differently fails a test
// instead of silently widening the brute-force window on one facade.

/**
 * Assert a runtime's {@link AuthAttemptRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; keys/ips are unique per run
 * so the shared database stays isolated between cases.
 */
export function defineAuthAttemptSuite(name: string, makeRepo: () => AuthAttemptRepository): void {
  describe(`[${name}] auth-attempt repository parity`, () => {
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ip: `ip-${tag}`, otherIp: `ip2-${tag}`, email: `mail-${tag}` }
    }

    it('counts attempts per key within the window only', async () => {
      const repo = makeRepo()
      const { ip, email } = ids()
      const key = `${ip}:${email}`
      await repo.record({ key, ip, at: 1_000 })
      await repo.record({ key, ip, at: 2_000 })
      await repo.record({ key, ip, at: 10_000 })

      expect(await repo.countByKeySince(key, 1_500)).toBe(2)
      expect(await repo.countByKeySince(key, 0)).toBe(3)
      expect(await repo.countByKeySince(`${ip}:someone-else`, 0)).toBe(0)
    })

    it('counts the per-IP aggregate across every key', async () => {
      // The credential-stuffing signature: one IP, many emails — each per-key bucket
      // stays under its cap, only the aggregate sees the sweep.
      const repo = makeRepo()
      const { ip, otherIp, email } = ids()
      await repo.record({ key: `${ip}:${email}-a`, ip, at: 1_000 })
      await repo.record({ key: `${ip}:${email}-b`, ip, at: 2_000 })
      await repo.record({ key: `${otherIp}:${email}-a`, ip: otherIp, at: 2_000 })

      expect(await repo.countByIpSince(ip, 0)).toBe(2)
      expect(await repo.countByIpSince(ip, 1_500)).toBe(1)
      expect(await repo.countByIpSince(otherIp, 0)).toBe(1)
    })

    it('prunes only attempts older than the cutoff', async () => {
      const repo = makeRepo()
      const { ip, email } = ids()
      const key = `${ip}:${email}`
      await repo.record({ key, ip, at: 1_000 })
      await repo.record({ key, ip, at: 5_000 })

      const removed = await repo.deleteOlderThan(2_000)
      expect(removed).toBe(1)
      expect(await repo.countByKeySince(key, 0)).toBe(1)
    })
  })
}
