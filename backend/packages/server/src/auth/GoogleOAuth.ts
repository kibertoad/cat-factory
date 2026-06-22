// Minimal Google OAuth2 / OpenID Connect web-flow client (the user login flow).
// Built on `fetch` only, so it runs in a plain Workers isolate and in Node — a
// mirror of GitHubOAuth. Endpoints default to Google's but are overridable for tests.

const DEFAULT_OAUTH_BASE = 'https://accounts.google.com'
const DEFAULT_API_BASE = 'https://www.googleapis.com'
const TOKEN_PATH = 'https://oauth2.googleapis.com/token'

export interface GoogleOAuthDependencies {
  clientId: string
  clientSecret: string
  /** OAuth host (authorize). Defaults to accounts.google.com. */
  oauthBase?: string
  /** Userinfo API base. Defaults to www.googleapis.com. */
  apiBase?: string
}

interface TokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

interface GoogleUserInfo {
  sub: string
  email?: string | null
  name?: string | null
  picture?: string | null
}

/** The Google identity behind an authorization code (the OAuth provider's subject). */
export interface GoogleIdentity {
  /** Google `sub` — the stable identity subject. */
  subject: string
  email: string | null
  name: string | null
  avatarUrl: string | null
}

export class GoogleOAuth {
  constructor(private readonly deps: GoogleOAuthDependencies) {}

  private get oauthBase(): string {
    return this.deps.oauthBase || DEFAULT_OAUTH_BASE
  }
  private get apiBase(): string {
    return this.deps.apiBase || DEFAULT_API_BASE
  }

  /** The Google URL the browser is sent to in order to authorise. */
  authorizeUrl(params: { redirectUri: string; state: string; scope?: string }): string {
    const url = new URL('/o/oauth2/v2/auth', this.oauthBase)
    url.searchParams.set('client_id', this.deps.clientId)
    url.searchParams.set('redirect_uri', params.redirectUri)
    url.searchParams.set('state', params.state)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', params.scope ?? 'openid email profile')
    return url.toString()
  }

  /** Exchange the callback `code` for an access token. */
  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const res = await fetch(TOKEN_PATH, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.deps.clientId,
        client_secret: this.deps.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    if (!res.ok) throw new Error(`Google token exchange failed (HTTP ${res.status})`)
    const body = (await res.json()) as TokenResponse
    if (!body.access_token) {
      throw new Error(body.error_description || body.error || 'Google returned no access token')
    }
    return body.access_token
  }

  /** Resolve the authenticated Google user behind an access token. */
  async fetchUser(accessToken: string): Promise<GoogleIdentity> {
    const res = await fetch(new URL('/oauth2/v3/userinfo', this.apiBase), {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new Error(`Google userinfo fetch failed (HTTP ${res.status})`)
    const info = (await res.json()) as GoogleUserInfo
    return {
      subject: info.sub,
      email: info.email ?? null,
      name: info.name ?? null,
      avatarUrl: info.picture ?? null,
    }
  }
}
