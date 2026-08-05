import { isAllowedMcpHttpUrl, redactSecrets } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The OAuth 2.1 wire half of MCP authorization: discovering where a remote server's authorization
// server lives, and the three token-endpoint calls that follow.
//
// Hand-rolled on `fetch`, for the reason slice 4's probe recorded about its MCP client and slice 3
// recorded about the server: this code is bundled into a Worker, so it is typed against the Web
// platform alone and may not reach for a library that assumes Node. It is also small — three form
// POSTs and a metadata walk — next to an OAuth client library's session handling, storage
// abstractions and interactive flows, none of which apply when the "client" is a backend minting a
// token for a container to use.
//
// Everything here is stateless. What PERSISTS (the grant) is `McpOAuthService`'s business; this
// module only ever turns a request into a token response or a cause.
// ---------------------------------------------------------------------------

/** How long the whole discovery walk, or one token call, may take. */
export const MCP_OAUTH_TIMEOUT_MS = 10_000

/** How many metadata documents one discovery walk fetches before giving up. */
const MAX_METADATA_FETCHES = 6

/** Injected so tests drive the whole flow without a network. */
export interface McpOAuthFetch {
  fetch?: typeof fetch
}

/** Where a server's authorization server is, and how it wants the client to authenticate. */
export interface McpOAuthEndpoints {
  authorizationUrl: string
  tokenUrl: string
  /**
   * Whether the token endpoint is asked for HTTP Basic client authentication instead of the
   * credentials-in-the-body form.
   *
   * Defaults to the body form (`client_secret_post`), which every authorization server this
   * platform has met accepts, and flips only when the AS metadata advertises Basic and NOT post.
   * Deciding it from the metadata rather than trying both matters because a retry-on-401 would
   * send the client secret twice, to a server that has already refused it once.
   */
  useBasicAuth: boolean
}

/** A token response, normalised. `expiresIn` is seconds, as the wire states it. */
export interface McpOAuthTokens {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  scope?: string
  tokenType?: string
}

/** A failure with a cause an operator can act on. Never carries a credential (see `describe`). */
export class McpOAuthError extends Error {
  constructor(
    message: string,
    /** True when retrying cannot help: the grant or the client registration must change. */
    readonly permanent: boolean,
  ) {
    super(message)
    this.name = 'McpOAuthError'
  }
}

/**
 * Discover a remote MCP server's authorization endpoints, per the MCP authorization spec: the
 * server's own protected-resource metadata (RFC 9728) names its authorization server, and that
 * server's metadata (RFC 8414, or OpenID Connect discovery) names the endpoints.
 *
 * The walk is what makes a vendor server connectable from a declaration that names only its url.
 * Without it a deployment has to find two endpoint URLs in a vendor's docs, and they are exactly
 * the strings a vendor changes when it re-platforms.
 *
 * Both discovered URLs are held to `isAllowedMcpHttpUrl` — the SAME floor a declared endpoint is
 * held to. A metadata document is a third party telling this deployment where to send its client
 * secret and receive its tokens, so the one rule that must not be relaxed by discovery is the one
 * that keeps that exchange off cleartext.
 */
export async function discoverMcpOAuthEndpoints(
  serverUrl: string,
  deps: McpOAuthFetch = {},
): Promise<McpOAuthEndpoints> {
  const doFetch = deps.fetch ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MCP_OAUTH_TIMEOUT_MS)
  let spent = 0
  const getJson = async (url: string): Promise<Record<string, unknown> | undefined> => {
    if (spent++ >= MAX_METADATA_FETCHES) return undefined
    try {
      const res = await doFetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (!res.ok) return undefined
      const body = (await res.json()) as unknown
      return body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined
    } catch {
      // A metadata document that is absent, unparseable or unreachable is not a failure on its
      // own: the walk has several candidates and only the LAST one exhausting them is the error.
      // silent-catch-ok: the caller throws a single, better-worded failure once every candidate is
      // spent, and reporting each 404 of a well-known probe would be noise about the normal path.
      return undefined
    }
  }

  try {
    const resource = await fetchProtectedResourceMetadata(serverUrl, getJson)
    const issuers = resource ? authorizationServersOf(resource) : []
    // No protected-resource metadata is the common case for a server that predates RFC 9728, and
    // the spec's own fallback is to treat the resource's origin as the issuer.
    const candidates = issuers.length ? issuers : [new URL(serverUrl).origin]
    for (const issuer of candidates) {
      const metadata = await fetchAuthorizationServerMetadata(issuer, getJson)
      if (!metadata) continue
      const endpoints = readEndpoints(metadata)
      if (endpoints) return endpoints
    }
    throw new McpOAuthError(
      `No OAuth metadata was found for ${serverUrl}. The server published neither protected-resource ` +
        `metadata nor authorization-server metadata this deployment could read, so its endpoints ` +
        `cannot be discovered. Declare authorizationUrl and tokenUrl on the tool server instead.`,
      true,
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The server's protected-resource metadata (RFC 9728). Tried PATH-AWARE first
 * (`/.well-known/oauth-protected-resource/v1/mcp` for a server at `/v1/mcp`), which is what the
 * RFC prescribes and what a host serving several resources under one origin needs, then at the
 * bare well-known path for the single-resource case.
 */
async function fetchProtectedResourceMetadata(
  serverUrl: string,
  getJson: (url: string) => Promise<Record<string, unknown> | undefined>,
): Promise<Record<string, unknown> | undefined> {
  const url = new URL(serverUrl)
  const path = url.pathname.replace(/\/+$/, '')
  const candidates = [
    ...(path && path !== '/' ? [`${url.origin}/.well-known/oauth-protected-resource${path}`] : []),
    `${url.origin}/.well-known/oauth-protected-resource`,
  ]
  for (const candidate of candidates) {
    const body = await getJson(candidate)
    if (body) return body
  }
  return undefined
}

/**
 * The authorization server's own metadata, over the three well-known locations in the order the
 * specs put them: RFC 8414's path-INSERTING form, its path-appending sibling, then OpenID Connect
 * discovery, which many vendors publish and no OAuth-only client would otherwise find.
 */
async function fetchAuthorizationServerMetadata(
  issuer: string,
  getJson: (url: string) => Promise<Record<string, unknown> | undefined>,
): Promise<Record<string, unknown> | undefined> {
  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    // silent-catch-ok: an unparseable issuer is one exhausted candidate among several, and the
    // caller reports the exhausted walk once.
    return undefined
  }
  const path = url.pathname.replace(/\/+$/, '')
  for (const candidate of [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}${path}/.well-known/oauth-authorization-server`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ]) {
    const body = await getJson(candidate)
    if (body) return body
  }
  return undefined
}

/** The `authorization_servers` list of a protected-resource document, as strings. */
function authorizationServersOf(metadata: Record<string, unknown>): string[] {
  const raw = metadata.authorization_servers
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : []
}

/** The two endpoints out of an AS metadata document, refusing either if it fails the URL floor. */
function readEndpoints(metadata: Record<string, unknown>): McpOAuthEndpoints | undefined {
  const authorizationUrl = metadata.authorization_endpoint
  const tokenUrl = metadata.token_endpoint
  if (typeof authorizationUrl !== 'string' || typeof tokenUrl !== 'string') return undefined
  if (!isAllowedMcpHttpUrl(authorizationUrl) || !isAllowedMcpHttpUrl(tokenUrl)) {
    throw new McpOAuthError(
      `The authorization server's metadata names endpoints this deployment refuses to use ` +
        `(${authorizationUrl} / ${tokenUrl}). An OAuth exchange carries the client secret and the ` +
        `tokens, so the endpoints must be https (plain http only on loopback).`,
      true,
    )
  }
  const methods = metadata.token_endpoint_auth_methods_supported
  const supported = Array.isArray(methods) ? methods : []
  return {
    authorizationUrl,
    tokenUrl,
    useBasicAuth:
      supported.includes('client_secret_basic') && !supported.includes('client_secret_post'),
  }
}

/** The authorization URL an operator's browser is sent to. */
export function buildAuthorizationUrl(input: {
  authorizationUrl: string
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  scopes?: string[]
  resource: string
}): string {
  const url = new URL(input.authorizationUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  // RFC 8707. The MCP authorization spec REQUIRES it: without it an authorization server serving
  // several MCP servers issues a token that any of them accepts, so a token granted for one
  // vendor surface is replayable against another.
  url.searchParams.set('resource', input.resource)
  if (input.scopes?.length) url.searchParams.set('scope', input.scopes.join(' '))
  return url.toString()
}

export interface TokenRequestInput {
  tokenUrl: string
  clientId: string
  clientSecret?: string
  useBasicAuth?: boolean
  resource: string
}

/** Exchange an authorization code (plus its PKCE verifier) for a token set. */
export function exchangeAuthorizationCode(
  input: TokenRequestInput & { code: string; redirectUri: string; codeVerifier: string },
  deps: McpOAuthFetch = {},
): Promise<McpOAuthTokens> {
  return tokenRequest(
    input,
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    },
    deps,
  )
}

/** Exchange a refresh token for a fresh token set. */
export function refreshAccessToken(
  input: TokenRequestInput & { refreshToken: string; scopes?: string[] },
  deps: McpOAuthFetch = {},
): Promise<McpOAuthTokens> {
  return tokenRequest(
    input,
    {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      ...(input.scopes?.length ? { scope: input.scopes.join(' ') } : {}),
    },
    deps,
  )
}

/** Mint a token from the deployment's own client credentials — the no-human grant. */
export function requestClientCredentialsToken(
  input: TokenRequestInput & { scopes?: string[] },
  deps: McpOAuthFetch = {},
): Promise<McpOAuthTokens> {
  return tokenRequest(
    input,
    {
      grant_type: 'client_credentials',
      ...(input.scopes?.length ? { scope: input.scopes.join(' ') } : {}),
    },
    deps,
  )
}

/**
 * One token-endpoint POST.
 *
 * The PERMANENCE of a failure is decided here rather than by the caller, and it is the field the
 * whole surface is built on: a 400 `invalid_grant` means the refresh token is dead and the board
 * must re-connect, while a 503 or a dropped connection means try again later. A caller that could
 * not tell them apart would either nag an operator to re-authorise through a vendor's outage or
 * silently retry a grant that will never work again.
 */
async function tokenRequest(
  input: TokenRequestInput,
  params: Record<string, string>,
  deps: McpOAuthFetch,
): Promise<McpOAuthTokens> {
  if (!isAllowedMcpHttpUrl(input.tokenUrl)) {
    throw new McpOAuthError(
      `The token endpoint ${input.tokenUrl} is not https (plain http is accepted only on ` +
        `loopback), and an OAuth exchange carries the client secret and the tokens.`,
      true,
    )
  }
  const body = new URLSearchParams({
    ...params,
    client_id: input.clientId,
    resource: input.resource,
  })
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (input.clientSecret) {
    if (input.useBasicAuth) {
      headers.authorization = `Basic ${base64(`${encodeURIComponent(input.clientId)}:${encodeURIComponent(input.clientSecret)}`)}`
    } else {
      body.set('client_secret', input.clientSecret)
    }
  }

  const doFetch = deps.fetch ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MCP_OAUTH_TIMEOUT_MS)
  let response: Response
  try {
    response = await doFetch(input.tokenUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })
  } catch (error) {
    throw new McpOAuthError(
      `The token endpoint could not be reached: ${describe(error)}`,
      // Transient by construction: nothing answered, so nothing has judged the grant.
      false,
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await readBody(response)
  const payload = parseJson(text)
  if (!response.ok) {
    const code = typeof payload?.error === 'string' ? payload.error : undefined
    const detail =
      (typeof payload?.error_description === 'string' ? payload.error_description : undefined) ??
      (text ? preview(text) : undefined)
    throw new McpOAuthError(
      `The token endpoint answered HTTP ${response.status}` +
        `${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}`,
      // 4xx is the authorization server JUDGING the request; 5xx is the server having a bad day.
      // `invalid_grant` inside a 4xx is the specific one that means "re-connect".
      response.status >= 400 && response.status < 500,
    )
  }
  const accessToken =
    payload && typeof payload.access_token === 'string' ? payload.access_token : ''
  if (!accessToken) {
    throw new McpOAuthError(
      `The token endpoint answered 200 with no access_token${text ? `: ${preview(text)}` : ''}`,
      true,
    )
  }
  return {
    accessToken,
    ...(typeof payload?.refresh_token === 'string' ? { refreshToken: payload.refresh_token } : {}),
    ...(typeof payload?.expires_in === 'number' ? { expiresIn: payload.expires_in } : {}),
    ...(typeof payload?.scope === 'string' ? { scope: payload.scope } : {}),
    ...(typeof payload?.token_type === 'string' ? { tokenType: payload.token_type } : {}),
  }
}

/**
 * The response body as text, or an empty string when the stream itself failed.
 *
 * A body that cannot be read is not a separate outcome worth reporting: the STATUS is what decides
 * the disposition above, and an unreadable 200 falls through to "answered with no access_token",
 * which is the honest description of what happened either way.
 */
async function readBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    // silent-catch-ok: see above — the status has already decided the outcome, and the caller
    // reports the missing body as part of a better-worded failure.
    return ''
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    // silent-catch-ok: a non-JSON error body is reported through `preview` by the caller, which is
    // the whole reason the raw text is kept beside the parse.
    return undefined
  }
}

/**
 * A bounded, SCRUBBED excerpt of a body or an error.
 *
 * Both are rendered in a browser and written to a log line, and an authorization server answers a
 * bad request with anything from a JSON error object to an HTML page from an auth proxy that
 * echoes the request — including, on the token endpoint above all, the credentials it just
 * refused. `redactSecrets` at the emit site is the rule that covers exactly this.
 */
function preview(text: string): string {
  return redactSecrets(text.slice(0, 400)) ?? ''
}

function describe(error: unknown): string {
  return preview(error instanceof Error ? error.message : String(error))
}

/** base64 (not url-safe) of a UTF-8 string, for the HTTP Basic header. */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
