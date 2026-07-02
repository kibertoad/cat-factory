import type { ConnectionTestResult, ProviderConfigField, UserSecretKind } from '@cat-factory/kernel'
import { getErrorMessage } from '@cat-factory/kernel'

// Registry of per-user secret KINDS. Each kind declares the config fields the UI
// renders (exactly one `secret: true` field — the value stored encrypted; the rest
// ride as non-secret metadata) and an optional connection test. New kinds (GitLab
// PAT, …) are a new registry entry + a new `UserSecretKind` value, no schema change.
//
// Mirrors the provider self-describe/test seam used by the environment + runner-pool
// providers — one mechanism, three consumers.

export interface UserSecretTestInput {
  secret: string
  metadata?: Record<string, string>
}

export interface UserSecretKindHandler {
  kind: UserSecretKind
  /** Display name shown in the connect form. */
  label: string
  /** Fields the UI renders. Exactly one has `secret: true` (→ the stored secret). */
  configFields: ProviderConfigField[]
  /** Probe the (unsaved) secret/metadata. Optional — absent ⇒ "nothing to test". */
  testConnection?(
    input: UserSecretTestInput,
    ctx: { fetch: typeof fetch },
  ): Promise<ConnectionTestResult>
}

/**
 * The app-owned registry of per-user secret kinds, keyed by `kind`. Constructed by the
 * composition root (via {@link defaultUserSecretKindRegistry} / `createBackendRegistries`)
 * and injected into {@link UserSecretService}. A deployment teaches the platform a custom
 * kind by holding the same instance and calling {@link register} — registration is by
 * reference, so it never depends on module identity (the old module-global-`Map` footgun
 * an externally-published adapter hit). Mirrors the backend-provider registries; see
 * `docs/initiatives/registry-di-migration.md`.
 */
export class UserSecretKindRegistry {
  private readonly map = new Map<UserSecretKind, UserSecretKindHandler>()

  /** Register (or replace by `kind`) a secret-kind handler. Returns `this` for chaining. */
  register(handler: UserSecretKindHandler): this {
    this.map.set(handler.kind, handler)
    return this
  }

  /** The handler for a kind, or undefined when unregistered. */
  get(kind: UserSecretKind): UserSecretKindHandler | undefined {
    return this.map.get(kind)
  }

  /** All registered handlers (for rendering the available connect forms). */
  list(): UserSecretKindHandler[] {
    return [...this.map.values()]
  }
}

/** A registry pre-loaded with the built-in `github_pat` kind. */
export function defaultUserSecretKindRegistry(): UserSecretKindRegistry {
  return new UserSecretKindRegistry().register(githubPatUserSecretKind)
}

// The token is always validated against (and used against) public github.com. A
// per-user GitHub Enterprise Server base is NOT offered: it is not threaded into the
// engine's GitHub client at run time (so a GHES base would silently not apply to real
// runs), and a strict SSRF guard would reject the internal hosts GHES typically runs
// on. Probing a user-supplied base would also be a server-side request-forgery vector.
const GITHUB_API_BASE = 'https://api.github.com'

/** The GitHub PAT kind: a single token secret, validated against github.com. */
export const githubPatUserSecretKind: UserSecretKindHandler = {
  kind: 'github_pat',
  label: 'GitHub personal access token',
  configFields: [
    {
      key: 'token',
      label: 'Personal access token',
      secret: true,
      required: true,
      placeholder: 'ghp_… (scopes: repo, workflow)',
      help: 'Runs you initiate use YOUR GitHub access (pushes, PR author, CI actor).',
    },
  ],
  async testConnection(input, ctx) {
    try {
      const res = await ctx.fetch(`${GITHUB_API_BASE}/user`, {
        headers: {
          authorization: `Bearer ${input.secret}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'cat-factory',
        },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) {
        return { ok: false, message: `GitHub rejected the token (HTTP ${res.status})` }
      }
      const user = (await res.json()) as { login?: string }
      return { ok: true, message: user.login ? `Authenticated as ${user.login}` : 'Token valid' }
    } catch (err) {
      return { ok: false, message: getErrorMessage(err) }
    }
  },
}
