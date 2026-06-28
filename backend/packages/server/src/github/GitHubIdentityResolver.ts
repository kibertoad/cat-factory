import type { VcsIdentity, VcsIdentityResolver } from '@cat-factory/kernel'

// Resolves a GitHub PAT to its account via `GET /user` — the same identity (the numeric
// user id) the OAuth login path keys on, so a PAT login and a GitHub OAuth login for the
// same person resolve to ONE canonical user. Used by the local-mode `/auth/pat` flow; it
// authenticates with the raw token directly (no App JWT / installation token), so it works
// for a classic or fine-grained PAT.

interface GitHubUserResponse {
  id?: number
  login?: string
  name?: string | null
  avatar_url?: string | null
  email?: string | null
}

export interface GitHubIdentityResolverOptions {
  /** REST API base, e.g. `https://api.github.com` (no trailing slash needed). */
  apiBase: string
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export class GitHubIdentityResolver implements VcsIdentityResolver {
  private readonly apiBase: string
  private readonly fetchImpl: typeof fetch

  constructor(options: GitHubIdentityResolverOptions) {
    this.apiBase = options.apiBase.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async resolveIdentity(token: string): Promise<VcsIdentity> {
    const res = await this.fetchImpl(`${this.apiBase}/user`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'cat-factory',
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`GitHub /user failed (HTTP ${res.status}): ${text.slice(0, 200)}`)
    }
    const user = (await res.json()) as GitHubUserResponse
    if (user.id == null || !user.login) {
      throw new Error('GitHub /user returned no account id')
    }
    return {
      provider: 'github',
      externalId: String(user.id),
      login: user.login,
      name: user.name ?? null,
      avatarUrl: user.avatar_url ?? null,
      email: user.email ?? null,
    }
  }
}
