import { describe, expect, it } from 'vitest'
import { ConflictError, NotFoundError, ValidationError } from '@cat-factory/kernel'
import type {
  EmailMessage,
  EmailSender,
  PasswordHasher,
  PasswordResetTokenRecord,
  PasswordResetTokenRepository,
  UserIdentityRecord,
  UserRecord,
  UserRepository,
} from '@cat-factory/kernel'
import { PasswordResetService } from './PasswordResetService.js'

// In-memory fakes exercising the security-critical service logic (no DB needed; the
// repository parity itself is covered by the cross-runtime conformance suite).

function fakeTokenRepo() {
  const rows = new Map<string, PasswordResetTokenRecord>()
  const repo: PasswordResetTokenRepository = {
    create: async (r) => void rows.set(r.id, { ...r }),
    findByTokenHash: async (h) => [...rows.values()].find((r) => r.tokenHash === h) ?? null,
    listPendingByUser: async (u) =>
      [...rows.values()].filter((r) => r.userId === u && r.status === 'pending'),
    setStatus: async (id, status) => {
      const r = rows.get(id)
      if (r) r.status = status
    },
    consume: async (id) => {
      const r = rows.get(id)
      if (!r || r.status !== 'pending') return false
      r.status = 'used'
      return true
    },
    deleteExpired: async (before) => {
      let n = 0
      for (const [id, r] of rows) {
        if (r.expiresAt < before) {
          rows.delete(id)
          n++
        }
      }
      return n
    },
  }
  return { repo, rows }
}

function fakeUserRepo(identities: UserIdentityRecord[], users: UserRecord[]) {
  const idents = [...identities]
  const repo: Partial<UserRepository> = {
    get: async (id) => users.find((u) => u.id === id) ?? null,
    getIdentity: async (provider, subject) =>
      idents.find((i) => i.provider === provider && i.subject === subject) ?? null,
    listIdentities: async (userId) => idents.filter((i) => i.userId === userId),
    linkIdentity: async (identity) => {
      const idx = idents.findIndex(
        (i) => i.provider === identity.provider && i.subject === identity.subject,
      )
      if (idx >= 0) idents[idx] = { ...identity }
      else idents.push({ ...identity })
    },
  }
  return { repo: repo as UserRepository, idents }
}

const passwordHasher: PasswordHasher = {
  hash: async (pw) => `hash:${pw}`,
  verify: async (pw, secret) => secret === `hash:${pw}`,
  needsRehash: () => false,
}

function captureSender() {
  const sent: EmailMessage[] = []
  const sender: EmailSender = { send: async (m) => void sent.push(m) }
  return { sender, sent }
}

/** Pull the raw token from a sent reset link (the only place it ever appears). */
function tokenFromLink(text: string): string {
  return /token=([a-f0-9]+)/.exec(text)?.[1] ?? ''
}

const user: UserRecord = {
  id: 'usr_1',
  name: 'A',
  email: 'a@example.com',
  avatarUrl: null,
  createdAt: 1,
}
const passwordIdentity: UserIdentityRecord = {
  userId: 'usr_1',
  provider: 'password',
  subject: 'a@example.com',
  secret: 'hash:oldpassword',
  metadata: null,
  createdAt: 1,
}

function makeService(overrides: {
  tokenRepo?: ReturnType<typeof fakeTokenRepo>
  userRepo?: ReturnType<typeof fakeUserRepo>
  sender?: EmailSender | null
  now?: number
}) {
  const tokenRepo = overrides.tokenRepo ?? fakeTokenRepo()
  const userRepo = overrides.userRepo ?? fakeUserRepo([passwordIdentity], [user])
  let seq = 0
  const service = new PasswordResetService({
    passwordResetTokenRepository: tokenRepo.repo,
    userRepository: userRepo.repo,
    passwordHasher,
    idGenerator: { next: (p) => `${p}_${++seq}` },
    clock: { now: () => overrides.now ?? 1_000 },
    resolveSystemEmailSender: async () => overrides.sender ?? null,
    appBaseUrl: 'https://app.example.com',
  })
  return { service, tokenRepo, userRepo }
}

describe('PasswordResetService.request', () => {
  it('mints a token and emails the reset link for a password user', async () => {
    const { sender, sent } = captureSender()
    const { service, tokenRepo } = makeService({ sender })

    await service.request('A@Example.com') // case-insensitive

    expect(tokenRepo.rows.size).toBe(1)
    const [record] = [...tokenRepo.rows.values()]
    expect(record!.status).toBe('pending')
    expect(record!.userId).toBe('usr_1')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('a@example.com')
    expect(sent[0]!.html).toContain('https://app.example.com/reset-password?token=')
  })

  it('is a silent no-op when no password identity owns the email (no enumeration)', async () => {
    const { sender, sent } = captureSender()
    const { service, tokenRepo } = makeService({
      sender,
      userRepo: fakeUserRepo([], []),
    })

    await service.request('ghost@example.com')

    expect(tokenRepo.rows.size).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('supersedes any prior pending token', async () => {
    const { service, tokenRepo } = makeService({})
    await service.request('a@example.com')
    await service.request('a@example.com')

    const pending = [...tokenRepo.rows.values()].filter((r) => r.status === 'pending')
    expect(pending).toHaveLength(1)
  })

  it('never throws when the email provider fails (no error-based enumeration)', async () => {
    const failing: EmailSender = {
      send: async () => {
        throw new Error('provider down')
      },
    }
    const { service, tokenRepo } = makeService({ sender: failing })

    // The registered path must resolve identically to the unregistered one — a thrown
    // send error would otherwise surface as a 500 only for registered emails.
    await expect(service.request('a@example.com')).resolves.toBeUndefined()
    // The token is still minted; only the delivery failed.
    expect(tokenRepo.rows.size).toBe(1)
  })
})

describe('PasswordResetService.reset', () => {
  it('sets the new password, consumes the token, and supersedes other pending tokens', async () => {
    const { sender, sent } = captureSender()
    const { service, tokenRepo, userRepo } = makeService({ sender })
    await service.request('a@example.com')
    const token = tokenFromLink(sent[0]!.text!)

    await service.reset(token, 'newpassword')

    const identity = userRepo.idents.find((i) => i.provider === 'password')
    expect(identity!.secret).toBe('hash:newpassword')
    expect([...tokenRepo.rows.values()].every((r) => r.status === 'used')).toBe(true)
  })

  it('rejects an unknown or already-used token', async () => {
    const { service } = makeService({})
    await expect(service.reset('deadbeef', 'newpassword')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('rejects an expired token', async () => {
    const { sender, sent } = captureSender()
    // Mint at t=1000 (TTL 1h), then reset far in the future.
    const tokenRepo = fakeTokenRepo()
    const userRepo = fakeUserRepo([passwordIdentity], [user])
    const minted = makeService({ tokenRepo, userRepo, sender, now: 1_000 })
    await minted.service.request('a@example.com')
    const token = tokenFromLink(sent[0]!.text!)

    const later = makeService({ tokenRepo, userRepo, now: 1_000 + 2 * 60 * 60 * 1000 })
    await expect(later.service.reset(token, 'newpassword')).rejects.toBeInstanceOf(ConflictError)
  })

  it('rejects a too-short password before touching the token', async () => {
    const { service } = makeService({})
    await expect(service.reset('whatever', 'short')).rejects.toBeInstanceOf(ValidationError)
  })

  it('is single-use: a second redemption of the same token is rejected', async () => {
    const { sender, sent } = captureSender()
    const { service } = makeService({ sender })
    await service.request('a@example.com')
    const token = tokenFromLink(sent[0]!.text!)

    await service.reset(token, 'newpassword')
    await expect(service.reset(token, 'anotherpassword')).rejects.toBeInstanceOf(NotFoundError)
  })
})
