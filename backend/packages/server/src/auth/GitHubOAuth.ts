import type { SessionUser } from './signing.js'

// Minimal GitHub OAuth web-flow client (the user-to-server login flow). Works
// with either a GitHub App's OAuth credentials or a classic OAuth App — both
// expose the same `/login/oauth/*` endpoints on github.com and `/user` on the
// REST API. Built on `fetch` only, so it runs in a plain Workers isolate and in Node.

const USER_AGENT = 'cat-factory'
const API_VERSION = '2022-11-28'

export interface GitHubOAuthDependencies {
  clientId: string
  clientSecret: string
  /** REST API base (e.g. https://api.github.com), used to read the user. */
  apiBase: string
  /** OAuth host (e.g. https://github.com), used for authorize/token. */
  oauthBase: string
}

interface TokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

interface GitHubUserResponse {
  id: number
  login: string
  name: string | null
  avatar_url: string | null
}

interface GitHubOrgResponse {
  login: string
}

export class GitHubOAuth {
  constructor(private readonly deps: GitHubOAuthDependencies) {}

  /** The github.com URL the browser is sent to in order to authorise. */
  authorizeUrl(params: { redirectUri: string; state: string; scope?: string }): string {
    const url = new URL('/login/oauth/authorize', this.deps.oauthBase)
    url.searchParams.set('client_id', this.deps.clientId)
    url.searchParams.set('redirect_uri', params.redirectUri)
    url.searchParams.set('state', params.state)
    // read:user is enough to identify the signer; harmless for GitHub Apps,
    // whose effective access is governed by the App's configured permissions.
    url.searchParams.set('scope', params.scope ?? 'read:user')
    url.searchParams.set('allow_signup', 'false')
    return url.toString()
  }

  /** Exchange the callback `code` for a user access token. */
  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const res = await fetch(new URL('/login/oauth/access_token', this.deps.oauthBase), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({
        client_id: this.deps.clientId,
        client_secret: this.deps.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    })
    if (!res.ok) throw new Error(`GitHub token exchange failed (HTTP ${res.status})`)
    const body = (await res.json()) as TokenResponse
    if (!body.access_token) {
      throw new Error(body.error_description || body.error || 'GitHub returned no access token')
    }
    return body.access_token
  }

  /** Resolve the authenticated GitHub user behind an access token. */
  async fetchUser(accessToken: string): Promise<SessionUser> {
    const res = await fetch(new URL('/user', this.deps.apiBase), {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': USER_AGENT,
        'x-github-api-version': API_VERSION,
      },
    })
    if (!res.ok) throw new Error(`GitHub user fetch failed (HTTP ${res.status})`)
    const user = (await res.json()) as GitHubUserResponse
    return { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatar_url }
  }

  /**
   * List the orgs the token's user belongs to, as lowercased logins. Requires
   * the token to carry `read:org` (the login flow requests it only when an org
   * allowlist is configured) so private memberships are visible. A single page
   * of up to 100 is read — well beyond any realistic membership count.
   */
  async fetchUserOrgs(accessToken: string): Promise<string[]> {
    const res = await fetch(new URL('/user/orgs?per_page=100', this.deps.apiBase), {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': USER_AGENT,
        'x-github-api-version': API_VERSION,
      },
    })
    if (!res.ok) throw new Error(`GitHub org list failed (HTTP ${res.status})`)
    const orgs = (await res.json()) as GitHubOrgResponse[]
    return orgs.map((org) => org.login.toLowerCase())
  }
}
