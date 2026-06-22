import { describe, expect, it } from 'vitest'
import { CredentialRequiredError } from '@cat-factory/kernel'
import type {
  PersonalSecretCipher,
  PersonalSubscriptionRecord,
  PersonalSubscriptionRepository,
  SecretCipher,
  SubscriptionActivationRecord,
  SubscriptionActivationRepository,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import {
  DEFAULT_ACTIVATION_TTL_MS,
  PersonalSubscriptionService,
} from './PersonalSubscriptionService.js'

// Service behaviour over in-memory repos + reversible ciphers: double-encryption at
// rest, password-gated unlock, per-run activation lifecycle, expiry/renewal status, and
// the individual-usage-only rule. The real Web Crypto cipher is exercised in the server
// package's crypto test.

// System layer: reversible "enc(...)" wrapper.
const systemCipher: SecretCipher = {
  encrypt: async (p) => `enc(${p})`,
  decrypt: async (e) => e.replace(/^enc\(([\s\S]*)\)$/, '$1'),
}

// Password layer: embeds the password so a wrong one fails on open (like AES-GCM auth).
const personalCipher: PersonalSecretCipher = {
  seal: async (plaintext, password) => `seal[${password}](${plaintext})`,
  open: async (envelope, password) => {
    const m = envelope.match(/^seal\[([^\]]*)\]\(([\s\S]*)\)$/)
    if (!m || m[1] !== password) throw new Error('wrong password')
    return m[2]!
  },
}

class FakeSubs implements PersonalSubscriptionRepository {
  rows: PersonalSubscriptionRecord[] = []
  private live() {
    return this.rows.filter((r) => r.deletedAt === null)
  }
  async getByUserVendor(userId: number, vendor: SubscriptionVendor) {
    return this.live().find((r) => r.userId === userId && r.vendor === vendor) ?? null
  }
  async listByUser(userId: number) {
    return this.live().filter((r) => r.userId === userId)
  }
  async upsert(record: PersonalSubscriptionRecord) {
    for (const r of this.live()) {
      if (r.userId === record.userId && r.vendor === record.vendor && r.id !== record.id)
        r.deletedAt = record.updatedAt
    }
    const i = this.rows.findIndex((r) => r.id === record.id)
    if (i >= 0) this.rows[i] = { ...record }
    else this.rows.push({ ...record })
  }
  async markUsed(userId: number, vendor: SubscriptionVendor, at: number) {
    const r = await this.getByUserVendor(userId, vendor)
    if (r) r.lastUsedAt = at
  }
  async softDelete(userId: number, vendor: SubscriptionVendor, at: number) {
    const r = await this.getByUserVendor(userId, vendor)
    if (r) r.deletedAt = at
  }
  async listExpiring(now: number, before: number) {
    return this.live().filter(
      (r) => r.expiresAt !== null && r.expiresAt >= now && r.expiresAt <= before,
    )
  }
}

class FakeActs implements SubscriptionActivationRepository {
  rows: SubscriptionActivationRecord[] = []
  async get(executionId: string, userId: number, vendor: SubscriptionVendor, now: number) {
    return (
      this.rows.find(
        (r) =>
          r.executionId === executionId &&
          r.userId === userId &&
          r.vendor === vendor &&
          r.expiresAt > now,
      ) ?? null
    )
  }
  async upsert(record: SubscriptionActivationRecord) {
    const i = this.rows.findIndex(
      (r) =>
        r.executionId === record.executionId &&
        r.userId === record.userId &&
        r.vendor === record.vendor,
    )
    if (i >= 0) this.rows[i] = { ...record }
    else this.rows.push({ ...record })
  }
  async refresh(
    executionId: string,
    userId: number,
    vendor: SubscriptionVendor,
    expiresAt: number,
  ) {
    const r = this.rows.find(
      (x) => x.executionId === executionId && x.userId === userId && x.vendor === vendor,
    )
    if (r) r.expiresAt = expiresAt
  }
  async deleteByExecution(executionId: string) {
    this.rows = this.rows.filter((r) => r.executionId !== executionId)
  }
  async deleteExpired(now: number) {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => r.expiresAt > now)
    return before - this.rows.length
  }
}

function makeService(now: () => number = () => 1000) {
  const subs = new FakeSubs()
  const acts = new FakeActs()
  let n = 0
  const svc = new PersonalSubscriptionService({
    personalSubscriptionRepository: subs,
    subscriptionActivationRepository: acts,
    secretCipher: systemCipher,
    personalCipher,
    idGenerator: { next: (p: string) => `${p}_${++n}` },
    clock: { now },
  })
  return { svc, subs, acts }
}

describe('PersonalSubscriptionService', () => {
  it('stores the credential double-encrypted and never returns the secret', async () => {
    const { svc, subs } = makeService()
    const status = await svc.store(7, {
      vendor: 'claude',
      label: 'mine',
      token: 'sk-ant-oat01-raw',
      password: 'hunter2hunter2',
      expiresAt: null,
    })
    expect(status.vendor).toBe('claude')
    expect(JSON.stringify(status)).not.toContain('sk-ant-oat01-raw')
    // At rest: the password layer is inside the system layer.
    expect(subs.rows[0]!.tokenCipher).toBe('enc(seal[hunter2hunter2](sk-ant-oat01-raw))')
  })

  it('rejects a non-individual (poolable) vendor', async () => {
    const { svc } = makeService()
    await expect(
      svc.store(7, { vendor: 'kimi', label: 'x', token: 't', password: 'longpassword' }),
    ).rejects.toBeInstanceOf(CredentialRequiredError)
  })

  it('activates a run and leases the decrypted token; unknown run lease fails', async () => {
    const { svc } = makeService()
    await svc.store(7, { vendor: 'claude', label: 'm', token: 'TOKEN', password: 'longpassword' })

    await svc.activateForRun('exec_1', 7, 'claude', 'longpassword')
    const leased = await svc.leaseForRun('exec_1', 7, 'claude')
    expect(leased).toEqual({ vendor: 'claude', secret: 'TOKEN' })

    await expect(svc.leaseForRun('exec_other', 7, 'claude')).rejects.toMatchObject({
      code: 'credential_required',
      details: { vendor: 'claude', reason: 'password_required' },
    })
  })

  it('rejects a wrong password on activation', async () => {
    const { svc } = makeService()
    await svc.store(7, { vendor: 'claude', label: 'm', token: 'T', password: 'rightpassword' })
    await expect(
      svc.activateForRun('exec_1', 7, 'claude', 'wrongpassword!!'),
    ).rejects.toMatchObject({ details: { reason: 'wrong_password' } })
  })

  it('blocks a lapsed subscription from unlocking', async () => {
    const { svc } = makeService(() => 10_000)
    await svc.store(7, {
      vendor: 'claude',
      label: 'm',
      token: 'T',
      password: 'longpassword',
      expiresAt: 9_000, // already past
    })
    await expect(svc.activateForRun('exec_1', 7, 'claude', 'longpassword')).rejects.toMatchObject({
      details: { reason: 'subscription_expired' },
    })
  })

  it('clears a run and sweeps expired activations', async () => {
    const { svc, acts } = makeService()
    await svc.store(7, { vendor: 'claude', label: 'm', token: 'T', password: 'longpassword' })
    await svc.activateForRun('exec_1', 7, 'claude', 'longpassword')
    expect(acts.rows).toHaveLength(1)

    await svc.clearRun('exec_1')
    expect(acts.rows).toHaveLength(0)

    // A directly-inserted stale activation is swept.
    await svc.activateForRun('exec_2', 7, 'claude', 'longpassword')
    acts.rows[0]!.expiresAt = 0
    expect(await svc.sweepExpiredActivations()).toBe(1)
  })

  it('computes expiry/renewal status and lists expiring subscriptions', async () => {
    const day = 24 * 60 * 60 * 1000
    const { svc } = makeService(() => 0)
    await svc.store(7, {
      vendor: 'claude',
      label: 'm',
      token: 'T',
      password: 'longpassword',
      expiresAt: 3 * day,
    })
    const [status] = await svc.list(7)
    expect(status!.expiresInDays).toBe(3)
    expect(status!.expired).toBe(false)
    expect(status!.renewSoon).toBe(true) // within the 7-day warning window

    const expiring = await svc.expiringSubscriptions()
    expect(expiring.map((r) => r.userId)).toEqual([7])
  })

  it('uses a short (12h) activation TTL by default', () => {
    expect(DEFAULT_ACTIVATION_TTL_MS).toBe(12 * 60 * 60 * 1000)
  })

  it('enforces one personal password across a user’s individual-usage subscriptions', async () => {
    const { svc } = makeService()
    await svc.store(7, { vendor: 'claude', label: 'c', token: 'T1', password: 'rightpassword' })
    // A second vendor sealed under a DIFFERENT password is rejected up-front (validation),
    // since one run unlocks every vendor it touches with a single password.
    await expect(
      svc.store(7, { vendor: 'glm', label: 'g', token: 'T2', password: 'otherpassword' }),
    ).rejects.toMatchObject({ code: 'validation' })
    // The SAME password is accepted.
    const ok = await svc.store(7, {
      vendor: 'glm',
      label: 'g',
      token: 'T2',
      password: 'rightpassword',
    })
    expect(ok.vendor).toBe('glm')
    // A different USER is unaffected by user 7's password.
    const other = await svc.store(9, {
      vendor: 'glm',
      label: 'g',
      token: 'T3',
      password: 'separatepassword',
    })
    expect(other.vendor).toBe('glm')
  })
})
