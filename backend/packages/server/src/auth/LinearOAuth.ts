// Minimal Linear OAuth2 web-flow client for the "Connect with Linear" task-source
// flow. Built on `fetch` only, so it runs in a plain Workers isolate and in Node —
// a mirror of GoogleOAuth. The returned access token is sent to Linear's GraphQL API
// as a `Bearer` token (see `linearAuthHeader` in @cat-factory/integrations), so the
// task source / tracker / writeback all work unchanged once a `{ token }` connection
// is stored. Endpoints default to Linear's but are overridable for tests.

const DEFAULT_OAUTH_BASE = 'https://linear.app'
const DEFAULT_TOKEN_URL = 'https://api.linear.app/oauth/token'

export interface LinearOAuthDependencies {
  clientId: string
  clientSecret: string
  /** OAuth host (authorize). Defaults to linear.app. */
  oauthBase?: string
  /** Token-exchange endpoint. Defaults to api.linear.app/oauth/token. */
  tokenUrl?: string
}

interface TokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

export class LinearOAuth {
  constructor(private readonly deps: LinearOAuthDependencies) {}

  private get oauthBase(): string {
    return this.deps.oauthBase || DEFAULT_OAUTH_BASE
  }
  private get tokenUrl(): string {
    return this.deps.tokenUrl || DEFAULT_TOKEN_URL
  }

  /** The Linear URL the browser is sent to in order to authorise. */
  authorizeUrl(params: { redirectUri: string; state: string; scope?: string }): string {
    const url = new URL('/oauth/authorize', this.oauthBase)
    url.searchParams.set('client_id', this.deps.clientId)
    url.searchParams.set('redirect_uri', params.redirectUri)
    url.searchParams.set('state', params.state)
    url.searchParams.set('response_type', 'code')
    // `read,write`: read to import/search issues + list teams, write to file tickets
    // and comment/transition on PR writeback.
    url.searchParams.set('scope', params.scope ?? 'read,write')
    return url.toString()
  }

  /** Exchange the callback `code` for an access token. */
  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const res = await fetch(this.tokenUrl, {
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
    if (!res.ok) throw new Error(`Linear token exchange failed (HTTP ${res.status})`)
    const body = (await res.json()) as TokenResponse
    if (!body.access_token) {
      throw new Error(body.error_description || body.error || 'Linear returned no access token')
    }
    return body.access_token
  }
}
