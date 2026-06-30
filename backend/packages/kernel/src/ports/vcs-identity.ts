import type { VcsProvider } from '../domain/vcs-types.js'

// ---------------------------------------------------------------------------
// Provider-agnostic "who owns this access token?" resolution.
//
// A source-control PAT (GitHub / GitLab / …) identifies a real person: every
// provider exposes a "current user" endpoint that, given the token, returns that
// account's stable numeric id + handle. This port turns a raw PAT into a neutral
// {@link VcsIdentity}, so the login layer can mint a session for "whoever this PAT
// belongs to" WITHOUT knowing which provider it is — the same way the rest of the
// platform talks to VCS systems through {@link VcsClient} behind the registry.
//
// It is deliberately decoupled from {@link VcsConnectionRef} / stored connection
// rows: identity resolution happens at LOGIN, before any connection exists, against
// a token the user just pasted (or one the deployment configured). Each provider
// package supplies a resolver (GitHub in @cat-factory/server, GitLab in
// @cat-factory/gitlab); a facade assembles the per-provider registry it can serve.
// ---------------------------------------------------------------------------

/** The account a {@link VcsIdentityResolver} resolved a PAT to. */
export interface VcsIdentity {
  /** Which provider the token authenticates against. */
  provider: VcsProvider
  /**
   * The provider's STABLE account id, as a string — the GitHub/GitLab numeric user
   * id. This is the collision-safe subject keyed under `(provider, subject)` in the
   * user-identity store, identical to the OAuth path's subject, so a PAT login and a
   * GitHub OAuth login resolve to the same canonical user.
   */
  externalId: string
  /** The account handle/username (GitHub login, GitLab username) — display + metadata. */
  login: string
  name: string | null
  avatarUrl: string | null
  /** The account's primary email, when the provider exposes it; else null. */
  email: string | null
}

/** Resolves a raw source-control PAT to the account it belongs to. */
export interface VcsIdentityResolver {
  /**
   * Verify `token` and return the account it authenticates as. MUST throw when the
   * token is invalid/revoked (the caller maps that to a 401), rather than returning a
   * partial/empty identity — a login must never succeed against a bad token.
   */
  resolveIdentity(token: string): Promise<VcsIdentity>
  /**
   * The lowercased org / group logins the token's account belongs to, when the provider
   * exposes them. Used by a HOSTED facade's PAT-login allowlist (a remote deployment admits
   * a PAT only when its login, an org it belongs to, or its email domain is allowlisted —
   * the same OR check the GitHub OAuth path applies). Optional: a provider that can't
   * enumerate orgs (or a deployment that doesn't gate on them) omits it, and the org branch
   * of the allowlist is simply skipped.
   */
  resolveOrgs?(token: string): Promise<string[]>
}

/** One provider's PAT-login capability: a resolver, plus any server-configured PAT. */
export interface VcsIdentityEntry {
  /** Turns a raw PAT into a {@link VcsIdentity} for this provider. */
  resolver: VcsIdentityResolver
  /**
   * A PAT the deployment configured for this provider (env). Present ⇒ one-click login is
   * available (the user need not paste a token); absent ⇒ enter-a-PAT only. NEVER serialized
   * to the client — only the provider name is advertised.
   */
  configuredToken?: string
}

/**
 * The per-provider PAT-login registry a facade assembles (local mode wires it; hosted
 * facades leave it undefined and the `/auth/pat` endpoint 503s). Keyed by provider so the
 * login layer stays branch-free across N providers.
 */
export type VcsIdentityRegistry = Partial<Record<VcsProvider, VcsIdentityEntry>>
