import { ConflictError, ValidationError } from '@cat-factory/kernel'
import type {
  Clock,
  IdGenerator,
  IdentityProvider,
  PasswordHasher,
  UserRecord,
  UserRepository,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// UserService: the canonical identity layer. A `users` row is the stable identity
// everything else keys off (memberships, block authorship, personal subscriptions),
// decoupled from GitHub. Each login provider (GitHub / password / Google) links an
// identity row back to the same user, so a person can sign in several ways — or with
// no GitHub account at all (repo access is via the GitHub App, not the user's token).
// ---------------------------------------------------------------------------

export interface UserServiceDependencies {
  userRepository: UserRepository
  passwordHasher: PasswordHasher
  idGenerator: IdGenerator
  clock: Clock
}

/** Profile details captured from an external identity provider. */
export interface IdentityProfile {
  name?: string | null
  email?: string | null
  avatarUrl?: string | null
  /** Provider-specific extras to persist as identity metadata (e.g. github login). */
  metadata?: Record<string, unknown>
}

export class UserService {
  constructor(private readonly deps: UserServiceDependencies) {}

  get(id: string): Promise<UserRecord | null> {
    return this.deps.userRepository.get(id)
  }

  /**
   * Resolve the user behind an external identity, creating the user + linking the
   * identity on first sight. Idempotent on `(provider, subject)`: repeated logins
   * return the same `usr_*` id. Used by all GitHub/Google login paths.
   */
  async findOrCreateByIdentity(
    provider: IdentityProvider,
    subject: string,
    profile: IdentityProfile = {},
  ): Promise<UserRecord> {
    const existing = await this.deps.userRepository.findByIdentity(provider, subject)
    if (existing) return existing
    const user: UserRecord = {
      id: this.deps.idGenerator.next('usr'),
      name: profile.name?.trim() || null,
      email: profile.email?.toLowerCase().trim() || null,
      avatarUrl: profile.avatarUrl || null,
      createdAt: this.deps.clock.now(),
    }
    await this.deps.userRepository.create(user)
    await this.deps.userRepository.linkIdentity({
      userId: user.id,
      provider,
      subject,
      secret: null,
      metadata: profile.metadata ? JSON.stringify(profile.metadata) : null,
      createdAt: this.deps.clock.now(),
    })
    return user
  }

  /** Link an additional identity to an existing user (onboarding follow-up). */
  async linkIdentity(
    userId: string,
    provider: IdentityProvider,
    subject: string,
    profile: IdentityProfile = {},
  ): Promise<void> {
    await this.deps.userRepository.linkIdentity({
      userId,
      provider,
      subject,
      secret: null,
      metadata: profile.metadata ? JSON.stringify(profile.metadata) : null,
      createdAt: this.deps.clock.now(),
    })
  }

  /**
   * Register a new email/password user. The email is the password identity's
   * subject; rejects when one already exists. Returns the created user.
   */
  async signupWithPassword(input: {
    email: string
    password: string
    name?: string | null
  }): Promise<UserRecord> {
    const email = input.email.toLowerCase().trim()
    if (!email) throw new ValidationError('Email is required')
    if (input.password.length < 8) {
      throw new ValidationError('Password must be at least 8 characters')
    }
    if (await this.deps.userRepository.getIdentity('password', email)) {
      throw new ConflictError('An account with that email already exists')
    }
    const user: UserRecord = {
      id: this.deps.idGenerator.next('usr'),
      name: input.name?.trim() || null,
      email,
      avatarUrl: null,
      createdAt: this.deps.clock.now(),
    }
    await this.deps.userRepository.create(user)
    await this.deps.userRepository.linkIdentity({
      userId: user.id,
      provider: 'password',
      subject: email,
      secret: await this.deps.passwordHasher.hash(input.password),
      metadata: null,
      createdAt: this.deps.clock.now(),
    })
    return user
  }

  /**
   * Verify an email/password login, returning the user on success or null on a bad
   * email/password (the caller maps null → 401, never leaking which was wrong).
   */
  async verifyPassword(input: { email: string; password: string }): Promise<UserRecord | null> {
    const email = input.email.toLowerCase().trim()
    const identity = await this.deps.userRepository.getIdentity('password', email)
    if (!identity?.secret) return null
    if (!(await this.deps.passwordHasher.verify(input.password, identity.secret))) return null
    return this.deps.userRepository.get(identity.userId)
  }
}
