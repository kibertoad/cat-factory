import type {
  SubscriptionActivationRecord,
  SubscriptionActivationRepository,
  UserRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the per-run personal-subscription activation store
// (`subscription_activations`: the short-lived, system-key-only credential copy a run leases
// so its async container steps can use the token without the user present). Each facade
// persists it in its own store (D1 on Cloudflare, Postgres via Drizzle on Node). This suite
// drives the SAME upsert → get (live-only) → deleteByExecution → TTL prune assertions through
// whichever real repository a runtime hands it, so a column mapped differently or a filter
// built differently fails a test instead of shipping. `deleteExpired` is the expiry sweep's
// write — it must delete activations whose TTL has passed and keep the ones still in force.
//
// The Postgres `subscription_activations.user_id` FK (ON DELETE RESTRICT) means a real
// `users` row must exist first, so the factory also hands back a UserRepository to seed one.

function activation(
  overrides: Partial<SubscriptionActivationRecord> &
    Pick<SubscriptionActivationRecord, 'id' | 'executionId' | 'userId'>,
): SubscriptionActivationRecord {
  return {
    vendor: 'claude',
    tokenCipher: `cipher-${overrides.id}`,
    createdAt: 1,
    expiresAt: 10_000,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link SubscriptionActivationRepository} behaves identically across
 * facades. `makeRepos` returns both the activation repo and a {@link UserRepository} over the
 * runtime's real store (the FK needs a real user); ids are unique per case so the shared
 * database stays isolated between cases.
 */
export function defineSubscriptionActivationSuite(
  name: string,
  makeRepos: () => {
    activations: SubscriptionActivationRepository
    users: Pick<UserRepository, 'create'>
  },
): void {
  describe(`[${name}] subscription-activation repository parity`, () => {
    let seq = 0
    const ids = async (users: Pick<UserRepository, 'create'>) => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      const user = `usr-${tag}`
      // Seed the referenced user so the Postgres FK is satisfied (D1 doesn't enforce it).
      await users.create({
        id: user,
        name: null,
        email: `${tag}@example.test`,
        avatarUrl: null,
        createdAt: 1,
      })
      return { user, tag }
    }

    it('reads back the live activation and treats a lapsed TTL as absent', async () => {
      const { activations, users } = makeRepos()
      const { user, tag } = await ids(users)
      const exec = `exec-${tag}`
      await activations.upsert(
        activation({ id: `act-${tag}`, executionId: exec, userId: user, expiresAt: 10_000 }),
      )

      const live = await activations.get(exec, user, 'claude', 5_000)
      expect(live).toMatchObject({
        executionId: exec,
        userId: user,
        tokenCipher: `cipher-act-${tag}`,
      })
      // Past the TTL the row is no longer leasable.
      expect(await activations.get(exec, user, 'claude', 20_000)).toBeNull()
    })

    it('upsert replaces the activation for the same (execution, user, vendor)', async () => {
      const { activations, users } = makeRepos()
      const { user, tag } = await ids(users)
      const exec = `exec-${tag}`
      await activations.upsert(
        activation({ id: `act-${tag}-a`, executionId: exec, userId: user, tokenCipher: 'first' }),
      )
      await activations.upsert(
        activation({ id: `act-${tag}-b`, executionId: exec, userId: user, tokenCipher: 'second' }),
      )
      expect((await activations.get(exec, user, 'claude', 5_000))?.tokenCipher).toBe('second')
    })

    it('deleteByExecution clears every activation for a finished run', async () => {
      const { activations, users } = makeRepos()
      const { user, tag } = await ids(users)
      const exec = `exec-${tag}`
      await activations.upsert(
        activation({ id: `act-${tag}-c`, executionId: exec, userId: user, vendor: 'claude' }),
      )
      await activations.upsert(
        activation({ id: `act-${tag}-x`, executionId: exec, userId: user, vendor: 'codex' }),
      )
      await activations.deleteByExecution(exec)
      expect(await activations.get(exec, user, 'claude', 5_000)).toBeNull()
      expect(await activations.get(exec, user, 'codex', 5_000)).toBeNull()
    })

    it('prunes activations whose TTL has passed, keeping the ones still in force', async () => {
      const { activations, users } = makeRepos()
      const { user, tag } = await ids(users)
      const expired = `exec-old-${tag}`
      const live = `exec-new-${tag}`
      const edge = `exec-edge-${tag}`
      await activations.upsert(
        activation({ id: `act-old-${tag}`, executionId: expired, userId: user, expiresAt: 1_000 }),
      )
      await activations.upsert(
        activation({ id: `act-new-${tag}`, executionId: live, userId: user, expiresAt: 9_000 }),
      )
      // Exactly ON the cutoff: unlike the other three prunes, `deleteExpired` is INCLUSIVE
      // (`expires_at <= now` — a TTL that lands on `now` has passed), so this must be
      // DELETED — a facade drifted to `<` would keep it and fail here.
      await activations.upsert(
        activation({ id: `act-edge-${tag}`, executionId: edge, userId: user, expiresAt: 2_000 }),
      )
      // Table-wide sweep, so its count can include other cases' rows in the shared DB —
      // assert the scoped, deterministic outcome instead.
      const removed = await activations.deleteExpired(2_000)
      expect(removed).toBeGreaterThanOrEqual(1)
      // `now: 0` reads the raw row (nothing is TTL-expired at time 0), so a non-null result
      // here means the row physically survived the sweep — not merely that it's still live.
      expect(await activations.get(expired, user, 'claude', 0)).toBeNull()
      expect(await activations.get(edge, user, 'claude', 0)).toBeNull()
      expect(await activations.get(live, user, 'claude', 0)).not.toBeNull()
    })
  })
}
