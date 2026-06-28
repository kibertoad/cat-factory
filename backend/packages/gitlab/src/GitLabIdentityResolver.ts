import type { VcsIdentity, VcsIdentityResolver } from '@cat-factory/kernel'
import { GITLAB_PUBLIC_API_BASE } from './tokenSource.js'

// Resolves a GitLab PAT to its account via `GET /api/v4/user` — the GitLab analogue of
// the GitHub resolver, keyed on the numeric user id so a GitLab PAT login lands on its own
// `(provider='gitlab', subject=<id>)` identity, never colliding with a GitHub one. Used by
// the local-mode `/auth/pat` flow; authenticates with the raw PAT via the `PRIVATE-TOKEN`
// header (the same header `FetchGitLabClient` uses).

interface GitLabUserResponse {
  id?: number
  username?: string
  name?: string | null
  avatar_url?: string | null
  email?: string | null
}

export interface GitLabIdentityResolverOptions {
  /** REST API base, e.g. `https://gitlab.com/api/v4`. Defaults to the public gitlab.com. */
  apiBase?: string
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export class GitLabIdentityResolver implements VcsIdentityResolver {
  private readonly apiBase: string
  private readonly fetchImpl: typeof fetch

  constructor(options: GitLabIdentityResolverOptions = {}) {
    this.apiBase = (options.apiBase ?? GITLAB_PUBLIC_API_BASE).replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async resolveIdentity(token: string): Promise<VcsIdentity> {
    const res = await this.fetchImpl(`${this.apiBase}/user`, {
      headers: {
        'private-token': token,
        accept: 'application/json',
        'user-agent': 'cat-factory',
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`GitLab /user failed (HTTP ${res.status}): ${text.slice(0, 200)}`)
    }
    const user = (await res.json()) as GitLabUserResponse
    if (user.id == null || !user.username) {
      throw new Error('GitLab /user returned no account id')
    }
    return {
      provider: 'gitlab',
      externalId: String(user.id),
      login: user.username,
      name: user.name ?? null,
      avatarUrl: user.avatar_url ?? null,
      email: user.email ?? null,
    }
  }
}
