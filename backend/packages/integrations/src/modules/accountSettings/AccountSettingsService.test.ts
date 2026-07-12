import { createAppCaches } from '@cat-factory/caching'
import { describe, expect, it, vi } from 'vitest'
import type {
  AccountSettingsRecord,
  AccountSettingsRepository,
  Clock,
  SecretCipher,
} from '@cat-factory/kernel'
import type { SlackOAuthSecret } from '@cat-factory/contracts'
import { AccountSettingsService } from './AccountSettingsService.js'

// A reversible fake system cipher (matches the shape UserSecretService's tests use): the
// sealed text is `enc(<plaintext>)`, so the decrypted secrets survive the round-trip and the
// test can assert on them after `resolve`.
const cipher: SecretCipher = {
  encrypt: async (p) => `enc(${p})`,
  decrypt: async (e) => e.replace(/^enc\(([\s\S]*)\)$/, '$1'),
}

const clock: Clock = { now: () => 1_700_000_000_000 }

function fakeRepo(seed: Map<string, AccountSettingsRecord> = new Map()): AccountSettingsRepository {
  return {
    async getByAccount(accountId) {
      return seed.get(accountId) ?? null
    },
    async upsert(record) {
      seed.set(record.accountId, record)
    },
    async listAll() {
      return [...seed.values()]
    },
  }
}

const slack = (clientId: string): SlackOAuthSecret => ({
  clientId,
  clientSecret: 'shh',
  redirectUrl: 'https://example.com/cb',
})

describe('AccountSettingsService cache (accountSettings slice)', () => {
  it('resolves through the cache — a second resolve does not re-hit the repository', async () => {
    const repo = fakeRepo()
    const getSpy = vi.spyOn(repo, 'getByAccount')
    const svc = new AccountSettingsService({
      accountSettingsRepository: repo,
      secretCipher: cipher,
      clock,
      settingsCache: createAppCaches().accountSettings,
    })

    // The "no row" case still resolves to a value (defaults + no secrets), so it must cache
    // rather than re-load on every miss.
    expect((await svc.resolve('acc_a')).slackOAuth).toBeUndefined()
    expect((await svc.resolve('acc_a')).slackOAuth).toBeUndefined()
    expect(getSpy).toHaveBeenCalledTimes(1)
  })

  it('write invalidates the cache — the next resolve reflects the new secrets immediately', async () => {
    const svc = new AccountSettingsService({
      accountSettingsRepository: fakeRepo(),
      secretCipher: cipher,
      clock,
      settingsCache: createAppCaches().accountSettings,
    })

    // Warm the cache with the pre-write (empty) resolution.
    expect((await svc.resolve('acc_a')).slackOAuth).toBeUndefined()

    await svc.write('acc_a', { secrets: { slackOAuth: slack('cid-1') } })

    // Without invalidation this would still serve the warmed (secret-less) value.
    expect((await svc.resolve('acc_a')).slackOAuth?.clientId).toBe('cid-1')
  })

  it('scopes cache entries per account', async () => {
    const svc = new AccountSettingsService({
      accountSettingsRepository: fakeRepo(),
      secretCipher: cipher,
      clock,
      settingsCache: createAppCaches().accountSettings,
    })

    // Seed both accounts, then warm both cache entries.
    await svc.write('acc_a', { secrets: { slackOAuth: slack('a-1') } })
    await svc.write('acc_b', { secrets: { slackOAuth: slack('b-1') } })
    expect((await svc.resolve('acc_a')).slackOAuth?.clientId).toBe('a-1')
    expect((await svc.resolve('acc_b')).slackOAuth?.clientId).toBe('b-1')

    // Re-writing acc_a drops only its entry; acc_b keeps serving its cached value.
    await svc.write('acc_a', { secrets: { slackOAuth: slack('a-2') } })
    expect((await svc.resolve('acc_a')).slackOAuth?.clientId).toBe('a-2')
    expect((await svc.resolve('acc_b')).slackOAuth?.clientId).toBe('b-1')
  })

  it('resolves fresh on every call when no cache is wired (pass-through parity)', async () => {
    const record: AccountSettingsRecord = {
      accountId: 'acc_a',
      config: '{}',
      secretsCipher: `enc(${JSON.stringify({ slackOAuth: slack('cid') })})`,
      summary: '{}',
      createdAt: 0,
      updatedAt: 0,
    }
    const repo = fakeRepo(new Map([['acc_a', record]]))
    const getSpy = vi.spyOn(repo, 'getByAccount')
    const svc = new AccountSettingsService({
      accountSettingsRepository: repo,
      secretCipher: cipher,
      clock,
    })

    expect((await svc.resolve('acc_a')).slackOAuth?.clientId).toBe('cid')
    expect((await svc.resolve('acc_a')).slackOAuth?.clientId).toBe('cid')
    // No cache ⇒ each resolve decrypts fresh — the same behaviour as the Worker's pass-through
    // isolate-safe profile.
    expect(getSpy).toHaveBeenCalledTimes(2)
  })
})
