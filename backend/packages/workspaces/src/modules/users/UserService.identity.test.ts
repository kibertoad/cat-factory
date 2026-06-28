import { describe, expect, it } from 'vitest'
import type {
  IdentityProvider,
  PasswordHasher,
  UserIdentityRecord,
  UserRecord,
  UserRepository,
} from '@cat-factory/kernel'
import { UserService } from './UserService.js'

// Identity collision-safety: a user is keyed on `(provider, subject)`, so the SAME numeric
// subject from DIFFERENT source-control providers (a GitHub PAT login and a GitLab PAT
// login) must resolve to DISTINCT users — they are different people who merely happen to
// share an account id on their respective platforms. This guards the local-mode PAT login,
// where both providers resolve identities the same way.

class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, UserRecord>()
  private readonly identities = new Map<string, UserIdentityRecord>()
  private key(provider: string, subject: string) {
    return `${provider}::${subject}`
  }
  get(id: string): Promise<UserRecord | null> {
    return Promise.resolve(this.users.get(id) ?? null)
  }
  create(user: UserRecord): Promise<void> {
    this.users.set(user.id, user)
    return Promise.resolve()
  }
  update(id: string, patch: Partial<Pick<UserRecord, 'name' | 'email' | 'avatarUrl'>>) {
    const u = this.users.get(id)
    if (u) this.users.set(id, { ...u, ...patch })
    return Promise.resolve()
  }
  findByIdentity(provider: IdentityProvider, subject: string): Promise<UserRecord | null> {
    const id = this.identities.get(this.key(provider, subject))?.userId
    return Promise.resolve(id ? (this.users.get(id) ?? null) : null)
  }
  findByEmail(email: string): Promise<UserRecord | null> {
    const lower = email.toLowerCase()
    return Promise.resolve([...this.users.values()].find((u) => u.email === lower) ?? null)
  }
  listByIds(ids: string[]): Promise<UserRecord[]> {
    return Promise.resolve(ids.map((i) => this.users.get(i)).filter((u): u is UserRecord => !!u))
  }
  getIdentity(provider: IdentityProvider, subject: string): Promise<UserIdentityRecord | null> {
    return Promise.resolve(this.identities.get(this.key(provider, subject)) ?? null)
  }
  linkIdentity(identity: UserIdentityRecord): Promise<void> {
    this.identities.set(this.key(identity.provider, identity.subject), identity)
    return Promise.resolve()
  }
  listIdentities(userId: string): Promise<UserIdentityRecord[]> {
    return Promise.resolve([...this.identities.values()].filter((i) => i.userId === userId))
  }
}

const passwordHasher: PasswordHasher = {
  hash: () => Promise.resolve('phc$stub'),
  verify: () => Promise.resolve(false),
  needsRehash: () => false,
}

function makeService() {
  let n = 0
  return new UserService({
    userRepository: new InMemoryUserRepository(),
    passwordHasher,
    idGenerator: { next: (p?: string) => `${p ?? 'id'}_${++n}` },
    clock: { now: () => 1_700_000_000_000 },
  })
}

describe('UserService identity collision-safety', () => {
  it('keeps GitHub and GitLab users distinct even with the same numeric id', async () => {
    const svc = makeService()
    // Same numeric subject "12345" on both platforms, different people (no shared email).
    const gh = await svc.findOrCreateByIdentity('github', '12345', { metadata: { login: 'gh' } })
    const gl = await svc.findOrCreateByIdentity('gitlab', '12345', { metadata: { login: 'gl' } })
    expect(gh.id).not.toBe(gl.id)
  })

  it('is idempotent per (provider, subject) — repeat logins return the same user', async () => {
    const svc = makeService()
    const first = await svc.findOrCreateByIdentity('gitlab', '999')
    const again = await svc.findOrCreateByIdentity('gitlab', '999')
    expect(again.id).toBe(first.id)
  })

  it('a password account (subject = email) never collides with a PAT identity', async () => {
    const svc = makeService()
    const gh = await svc.findOrCreateByIdentity('github', '42')
    const pw = await svc.signupWithPassword({ email: 'dev@example.com', password: 'hunter2pw' })
    expect(pw.id).not.toBe(gh.id)
    // The github numeric subject and the password's email subject live in separate
    // namespaces, so resolving each returns its own user.
    expect((await svc.findByIdentity('github', '42'))?.id).toBe(gh.id)
    expect((await svc.findByIdentity('password', 'dev@example.com'))?.id).toBe(pw.id)
  })
})
