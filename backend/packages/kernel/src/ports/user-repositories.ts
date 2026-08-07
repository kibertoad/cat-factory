// ---------------------------------------------------------------------------
// Persistence ports for the user-identity layer. A `users` row is the canonical,
// runtime-neutral identity (generated `usr_*` id) that everything else keys off
// (memberships, block authorship, personal subscriptions). It is decoupled from
// GitHub: a user may sign in with GitHub, email/password, and/or Google, and each
// of those is a row in `user_identities` linked back to the same user.
//
// This is what lets a person without a GitHub account exist in the system — repo
// access is via the GitHub *App* installation token (system-level), never the
// user's own GitHub OAuth token, so a non-GitHub user can still read/write repos.
// ---------------------------------------------------------------------------

/**
 * The login providers an identity can come from. `github`/`gitlab` are sourced from a
 * source-control account (OAuth in hosted mode, or a PAT in local mode — both resolve to
 * the provider's stable numeric user id as the `subject`); `google` from Google OAuth;
 * `oidc` from the deployment's own enterprise identity provider (Okta, Entra ID, Keycloak,
 * PingFederate, a Shibboleth OP …), reached through one generic OpenID Connect adapter;
 * `password` is a cat-factory-generated account keyed on the email. Because the identity
 * store keys on `(provider, subject)`, these namespaces never collide — a GitHub user, a
 * GitLab user, and a password user are distinct rows even if their subjects coincide.
 *
 * `oidc` is the one member whose subject is COMPOUND (`<issuer>#<sub>`, minted by
 * `oidcIdentitySubject`): an OIDC `sub` is unique per issuer and not globally, so keying on
 * it alone would let two directories collide on one row the day a deployment re-points at a
 * second provider.
 */
export type IdentityProvider = 'github' | 'gitlab' | 'password' | 'google' | 'oidc'

/** The canonical user record. */
export interface UserRecord {
  /** Generated `usr_*` id — the stable identity everything else references. */
  id: string
  name: string | null
  /** Primary email (unique when present). Null for a GitHub-only user with no public email. */
  email: string | null
  avatarUrl: string | null
  createdAt: number
}

/**
 * A linked login identity for a user. The pair `(provider, subject)` is unique —
 * one external identity maps to exactly one user.
 */
export interface UserIdentityRecord {
  userId: string
  provider: IdentityProvider
  /**
   * The provider's stable subject: the GitHub numeric id (as a string), the Google
   * `sub`, or the lowercased email for a `password` identity.
   */
  subject: string
  /** PHC-format password hash for `provider: 'password'`; null otherwise. */
  secret: string | null
  /** Provider-specific JSON metadata (github `{login, avatarUrl}`, google `{email}`). */
  metadata: string | null
  createdAt: number
}

export interface UserRepository {
  get(id: string): Promise<UserRecord | null>
  create(user: UserRecord): Promise<void>
  update(
    id: string,
    patch: Partial<Pick<UserRecord, 'name' | 'email' | 'avatarUrl'>>,
  ): Promise<void>
  /** The user behind a linked identity, or null. */
  findByIdentity(provider: IdentityProvider, subject: string): Promise<UserRecord | null>
  /**
   * The user owning a primary email (case-insensitive), or null. Lets a verified
   * second login provider (or password signup) attach to / be rejected against the
   * existing person instead of colliding on the unique email index.
   */
  findByEmail(email: string): Promise<UserRecord | null>
  /** Bulk-load users by id (the member-roster enrichment; order not guaranteed). */
  listByIds(ids: string[]): Promise<UserRecord[]>
  /** The raw identity row (carries the password `secret`), or null. */
  getIdentity(provider: IdentityProvider, subject: string): Promise<UserIdentityRecord | null>
  /** Link an external identity to a user (idempotent on `(provider, subject)`). */
  linkIdentity(identity: UserIdentityRecord): Promise<void>
  /** Every identity linked to a user. */
  listIdentities(userId: string): Promise<UserIdentityRecord[]>
  /**
   * The user's current SESSION GENERATION, or null when no such user exists.
   *
   * A session token carries the generation it was minted under, and a bearer whose claim no
   * longer matches the row is refused. That is what makes bulk revocation one row write instead
   * of a token blocklist: nothing has to enumerate the outstanding tokens to invalidate them.
   *
   * Null is a distinct answer from `0` and both are load-bearing. `0` is a user who has never
   * revoked anything, whose tokens are all still good; null is a user the store cannot find,
   * whose bearer must be refused rather than compared against a generation that does not exist.
   * A reader that flattened the two would keep serving a deleted user's token forever.
   */
  sessionGeneration(userId: string): Promise<number | null>
  /**
   * Invalidate every session the user currently holds by advancing their generation, returning
   * the new value.
   *
   * The increment is done IN THE STORE (`session_generation + 1`), never read-modify-written here:
   * two admins offboarding the same person concurrently would otherwise both read `3` and both
   * write `4`, which is harmless, and a bump racing a mint would not be — the mint would stamp a
   * generation the revocation had already decided to leave behind. A returned value is the one
   * the row now holds, so the caller invalidating a cached read cannot cache a number the store
   * never had.
   *
   * Throws when the user does not exist: a revocation that silently matched no row is the one
   * outcome an offboarding tool must not have, because it reports success for access it did not
   * withdraw.
   */
  bumpSessionGeneration(userId: string): Promise<number>
}
