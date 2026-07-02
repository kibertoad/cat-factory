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

interface GitHubOrgResponse {
  login?: string
}

export interface GitHubIdentityResolverOptions {
  /** REST API base, e.g. `https://api.github.com` (no trailing slash needed). */
  apiBase: string
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Optional sink, warned when org enumeration hits the page cap (see {@link resolveOrgs}). */
  logger?: { warn: (message: string) => void }
}

// Bound on org pagination for the PAT-login allowlist: ~1000 orgs. A user in more orgs than
// this whose only allowlisted org falls past the cap would be wrongly denied, so we
// `logger.warn` when we truncate.
const MAX_PAGES = 10

export class GitHubIdentityResolver implements VcsIdentityResolver {
  private readonly apiBase: string
  private readonly fetchImpl: typeof fetch
  private readonly logger?: { warn: (message: string) => void }

  constructor(options: GitHubIdentityResolverOptions) {
    this.apiBase = options.apiBase.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.logger = options.logger
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

  // The orgs the PAT's account belongs to (lowercased), for a hosted facade's PAT-login org
  // allowlist. Mirrors `GitHubOAuth.fetchUserOrgs`, but authenticates with the raw PAT — so it
  // sees the orgs the token is authorized for (a fine-grained PAT must grant org read, or a
  // classic PAT `read:org`; orgs it can't see simply don't appear and won't admit the user).
  // A token that lacks org read makes GitHub reject this with a non-2xx, which we surface by
  // throwing so the caller can distinguish "insufficient scope" from "no qualifying org". We
  // follow `Link: rel="next"` pagination up to {@link MAX_PAGES} so a user in many orgs is not
  // denied just because their allowlisted org sat on a later page.
  async resolveOrgs(token: string): Promise<string[]> {
    const all: string[] = []
    let url: string | undefined = `${this.apiBase}/user/orgs?per_page=100`
    let page = 0
    for (; url && page < MAX_PAGES; page++) {
      const res = await this.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'cat-factory',
        },
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`GitHub /user/orgs failed (HTTP ${res.status}): ${text.slice(0, 200)}`)
      }
      const orgs = (await res.json()) as GitHubOrgResponse[]
      for (const org of orgs) {
        if (org.login) all.push(org.login.toLowerCase())
      }
      url = parseNextLink(res.headers.get('link'))
    }
    if (url) {
      this.logger?.warn(
        `GitHub org listing truncated at MAX_PAGES=${MAX_PAGES} (~${100 * MAX_PAGES} orgs) ` +
          'during PAT-login org admission; a user in more orgs may be wrongly denied.',
      )
    }
    return all
  }
}

/** Extract the `rel="next"` URL from a GitHub `Link` header, if any. */
function parseNextLink(link: string | null): string | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match) return match[1]
  }
  return undefined
}
