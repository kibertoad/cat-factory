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

interface GitLabGroupResponse {
  full_path?: string
  path?: string
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

  // The GitLab groups the PAT's account is a member of (lowercased full paths), for a hosted
  // facade's PAT-login org allowlist — the GitLab analogue of GitHub's `resolveOrgs`. Without
  // this, a hosted deployment that admits users by group membership (`AUTH_ALLOWED_ORGS`) could
  // NOT admit a GitLab user (the org branch of `isPatIdentityAllowed` is skipped when the
  // resolver can't enumerate orgs), so GitLab couldn't be a primary auth identity there.
  //
  // `min_access_level=10` (Guest) restricts the listing to groups the user actually BELONGS to,
  // never the public groups `/groups` would otherwise return — admission must not widen to a
  // group the user merely can see. The identifier is the group's `full_path` (globally unique,
  // and it encodes subgroups, e.g. `acme/platform`), so an operator lists GitLab group full paths
  // in `AUTH_ALLOWED_ORGS`. Membership is not path-inherited upward, so only the groups the API
  // returns admit — matching GitHub, where only orgs the token can see appear.
  async resolveOrgs(token: string): Promise<string[]> {
    const res = await this.fetchImpl(`${this.apiBase}/groups?min_access_level=10&per_page=100`, {
      headers: {
        'private-token': token,
        accept: 'application/json',
        'user-agent': 'cat-factory',
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`GitLab /groups failed (HTTP ${res.status}): ${text.slice(0, 200)}`)
    }
    const groups = (await res.json()) as GitLabGroupResponse[]
    return groups.flatMap((group) => {
      const path = group.full_path ?? group.path
      return path ? [path.toLowerCase()] : []
    })
  }
}
