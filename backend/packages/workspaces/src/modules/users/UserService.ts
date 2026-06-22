import { ConflictError, ValidationError } from '@cat-factory/kernel'
import type {
  Clock,
  IdGenerator,
  IdentityProvider,
  PasswordHasher,
  UserIdentityRecord,
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
  /**
   * Whether the provider has verified the user owns `email`. Only a verified email is
   * trusted to link this identity onto an existing same-email user (else two people
   * who happen to share an email could merge into one account).
   */
  emailVerified?: boolean
  /** Provider-specific extras to persist as identity metadata (e.g. github login). */
  metadata?: Record<string, unknown>
}

// A dummy PHC hash the password verify path runs against when no password identity
// exists, so a miss costs the same PBKDF2 work as a hit and response time can't be used
// to enumerate which emails are registered. It is computed once per process from the
// REAL hasher (over a random, unguessable input) so its cost always tracks the hasher's
// current iteration count — a hardcoded string would silently drift if the default cost
// were raised, reopening the timing oracle. Cached process-wide (not per instance) so
// every miss pays exactly one PBKDF2, matching the single derivation a hit performs.
let dummyHashPromise: Promise<string> | undefined
function dummyPasswordHash(hasher: PasswordHasher): Promise<string> {
  return (dummyHashPromise ??= hasher.hash(crypto.randomUUID()))
}

export class UserService {
  constructor(private readonly deps: UserServiceDependencies) {}

  get(id: string): Promise<UserRecord | null> {
    return this.deps.userRepository.get(id)
  }

  /** The user behind an external identity, or null (no side effects). */
  findByIdentity(provider: IdentityProvider, subject: string): Promise<UserRecord | null> {
    return this.deps.userRepository.findByIdentity(provider, subject)
  }

  /** Every linked login identity for a user (the account-settings "connected logins"). */
  listIdentities(userId: string): Promise<UserIdentityRecord[]> {
    return this.deps.userRepository.listIdentities(userId)
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

    let email = profile.email?.toLowerCase().trim() || null
    // Is this email already owned by another user? (Unique-index-safe handling below.)
    const emailOwner = email ? await this.deps.userRepository.findByEmail(email) : null
    if (emailOwner) {
      if (profile.emailVerified && (await this.emailIsProviderVerified(emailOwner.id))) {
        // A second login provider for the same person — attach this identity to the
        // existing same-email user instead of creating a duplicate (which would collide
        // on the unique email index and 500). Only safe when the existing owner's email
        // was itself proven by an OAuth provider, never by a self-asserted signup.
        await this.deps.userRepository.linkIdentity({
          userId: emailOwner.id,
          provider,
          subject,
          secret: null,
          metadata: profile.metadata ? JSON.stringify(profile.metadata) : null,
          createdAt: this.deps.clock.now(),
        })
        return emailOwner
      }
      if (profile.emailVerified) {
        // The email is owned only via an UNVERIFIED password signup (the owner has no
        // OAuth identity). Password signup never proves email ownership, so that claim
        // can't block the genuinely-verified party from this provider. Release the email
        // from the squatting account and let the verified login take it on a fresh user.
        // (The squatter keeps its now-emailless, password-only account; acceptable per
        // the pre-1.0 policy — and it stops a pre-registration account-hijack.)
        await this.deps.userRepository.update(emailOwner.id, { email: null })
      } else {
        // Unverified and the email belongs to someone else: never trusted to claim or
        // merge it, and storing it would collide on the unique index. Create a distinct
        // user with no email rather than failing the login.
        email = null
      }
    }

    const user: UserRecord = {
      id: this.deps.idGenerator.next('usr'),
      name: profile.name?.trim() || null,
      email,
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

  /**
   * Whether a user's primary email was proven by an OAuth provider rather than a
   * self-asserted password signup. `users.email` is only ever written by (a) a
   * verified OAuth create/link or (b) a `password` signup; password is the sole
   * unverified writer. So "owns an email AND has a non-password identity" is a sound
   * proxy for "email is provider-verified" — used to refuse merging a verified login
   * onto a squatted, password-only account.
   */
  private async emailIsProviderVerified(userId: string): Promise<boolean> {
    const identities = await this.deps.userRepository.listIdentities(userId)
    return identities.some((i) => i.provider !== 'password')
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
    // Reject if ANY user already owns this email (not just a prior password identity):
    // attaching a password to an existing OAuth-only account via an unauthenticated
    // signup would be account takeover, and a duplicate would collide on the unique
    // email index. The owner can add a password later from an authenticated session.
    if (await this.deps.userRepository.findByEmail(email)) {
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
    if (!identity?.secret) {
      // Equalise timing with the hit path so the response time can't reveal whether the
      // email is registered (PBKDF2 against a dummy hash that can never match).
      await this.deps.passwordHasher.verify(input.password, await dummyPasswordHash(this.deps.passwordHasher))
      return null
    }
    if (!(await this.deps.passwordHasher.verify(input.password, identity.secret))) return null
    // Transparently upgrade a weaker-cost hash now that we hold the plaintext.
    if (this.deps.passwordHasher.needsRehash(identity.secret)) {
      await this.deps.userRepository.linkIdentity({
        ...identity,
        secret: await this.deps.passwordHasher.hash(input.password),
      })
    }
    return this.deps.userRepository.get(identity.userId)
  }
}
