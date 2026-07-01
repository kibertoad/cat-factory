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
  /** Optional sink, warned when group enumeration hits the page cap (see {@link resolveOrgs}). */
  logger?: { warn: (message: string) => void }
}

// Bound on group pagination for the PAT-login org allowlist: ~1000 groups (mirrors
// `FetchGitLabClient`'s cap). A user in more groups than this whose only allowlisted group
// falls past the cap would be wrongly denied, so we `logger.warn` when we truncate.
const MAX_PAGES = 10

export class GitLabIdentityResolver implements VcsIdentityResolver {
  private readonly apiBase: string
  private readonly fetchImpl: typeof fetch
  private readonly logger?: { warn: (message: string) => void }

  constructor(options: GitLabIdentityResolverOptions = {}) {
    this.apiBase = (options.apiBase ?? GITLAB_PUBLIC_API_BASE).replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.logger = options.logger
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
  //
  // The account needs a token scope that can read groups (`read_api`/`api`); a narrower token
  // (e.g. `read_user`-only) makes GitLab reject this with a non-2xx, which we surface by throwing
  // so the caller can distinguish "insufficient scope" from "no qualifying group". We follow
  // `Link: rel="next"` pagination up to {@link MAX_PAGES} so a user in many groups is not denied
  // just because their allowlisted group sat on a later page.
  async resolveOrgs(token: string): Promise<string[]> {
    const all: string[] = []
    let url: string | undefined = `${this.apiBase}/groups?min_access_level=10&per_page=100`
    let page = 0
    for (; url && page < MAX_PAGES; page++) {
      const res = await this.fetchImpl(url, {
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
      for (const group of groups) {
        const path = group.full_path ?? group.path
        if (path) all.push(path.toLowerCase())
      }
      url = parseNextLink(res.headers.get('link'))
    }
    if (url) {
      this.logger?.warn(
        `GitLab group listing truncated at MAX_PAGES=${MAX_PAGES} (~${100 * MAX_PAGES} groups) ` +
          'during PAT-login org admission; a user in more groups may be wrongly denied.',
      )
    }
    return all
  }
}

/** Extract the `rel="next"` URL from a `Link` header, if any (GitLab keyset/offset pagination). */
function parseNextLink(link: string | null): string | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match) return match[1]
  }
  return undefined
}
