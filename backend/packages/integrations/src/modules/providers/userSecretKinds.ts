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

const registry = new Map<UserSecretKind, UserSecretKindHandler>()

/** Register a per-user secret kind (call once at startup; later wins on conflict). */
export function registerUserSecretKind(handler: UserSecretKindHandler): void {
  registry.set(handler.kind, handler)
}

export function getUserSecretKind(kind: UserSecretKind): UserSecretKindHandler | undefined {
  return registry.get(kind)
}

export function listUserSecretKinds(): UserSecretKindHandler[] {
  return [...registry.values()]
}

const GITHUB_API_DEFAULT = 'https://api.github.com'

/** The GitHub PAT kind: a token secret + an optional GHES API base. */
registerUserSecretKind({
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
    {
      key: 'apiBase',
      label: 'GitHub API base URL',
      required: false,
      placeholder: GITHUB_API_DEFAULT,
      help: 'Only for GitHub Enterprise Server; leave blank for github.com.',
    },
  ],
  async testConnection(input, ctx) {
    const apiBase = (input.metadata?.apiBase?.trim() || GITHUB_API_DEFAULT).replace(/\/+$/, '')
    try {
      const res = await ctx.fetch(`${apiBase}/user`, {
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
})
