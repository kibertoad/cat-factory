import { redact } from '../redact.js'

// The pure half of the access tool server: which origins a credential may reach, how a
// credential is attached to a request, and how a target's response is scrubbed before the model
// sees it. No IO, so each rule is unit-tested on its own.

/** A credential the project run was handed, with its resolved value. */
export interface AccessCredential {
  key: string
  kind: 'login' | 'api-token' | 'oauth-client' | 'secret'
  value: string
}

export interface AccessTarget {
  baseUrl: string
  surface: 'ui' | 'api'
  /** `write` admits any method through `http_request`; `read` only the methods that read. */
  access: 'read' | 'write'
  /** When set, `http_request` reaches only paths at or under it on the target's origin. */
  pathPrefix?: string
}

/** The methods a read-only target admits. */
export const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * The target a request URL falls under: its origin, and within its path prefix when it has one.
 * The most specific prefix wins, so a narrower writable path inside a read-only API is honoured.
 * The URL parser resolves dot segments (encoded ones too) before the prefix is compared.
 */
export function targetFor(url: string, targets: readonly AccessTarget[]): AccessTarget | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const matching = targets.filter((target) => {
    try {
      return (
        new URL(target.baseUrl).origin === parsed.origin &&
        withinPrefix(parsed.pathname, target.pathPrefix)
      )
    } catch {
      return false
    }
  })
  return matching.sort((a, b) => (b.pathPrefix?.length ?? 0) - (a.pathPrefix?.length ?? 0))[0]
}

/**
 * A path a server could resolve differently from how it reads here: an encoded slash, backslash or
 * dot, or a `;` parameter (`..;` climbs on some servlet stacks). Such a path never matches a path
 * prefix, so it reaches only an origin-wide target.
 */
const AMBIGUOUS_PATH = /%2f|%5c|%2e|;/i

function withinPrefix(path: string, prefix: string | undefined): boolean {
  if (!prefix) return true
  if (AMBIGUOUS_PATH.test(path)) return false
  const root = prefix.length > 1 && prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`)
}

/** How a target is named in a refusal: its origin and, when it has one, its path prefix. */
export function describeTarget(target: AccessTarget): string {
  try {
    return `${new URL(target.baseUrl).origin}${target.pathPrefix ?? ''}`
  } catch {
    return target.baseUrl
  }
}

/** How `http_request` attaches a credential. */
export type AuthScheme =
  | { scheme: 'bearer' }
  | { scheme: 'basic' }
  | { scheme: 'header'; name: string }
  | { scheme: 'query'; name: string }
  | { scheme: 'oauth-client' }

/** The origins of the definition's targets: the only places a credential is sent. */
export function targetOrigins(targets: readonly AccessTarget[]): Set<string> {
  const origins = new Set<string>()
  for (const target of targets) {
    try {
      origins.add(new URL(target.baseUrl).origin)
    } catch {
      // A malformed target names no origin, so it admits nothing.
    }
  }
  return origins
}

export function isTargetOrigin(url: string, origins: ReadonlySet<string>): boolean {
  try {
    return origins.has(new URL(url).origin)
  } catch {
    return false
  }
}

/** A `login` credential's two halves, stored as `{ "username": …, "password": … }`. */
export function loginFields(value: string): { username: string; password: string } | null {
  try {
    const parsed = JSON.parse(value) as { username?: unknown; password?: unknown }
    return typeof parsed.username === 'string' && typeof parsed.password === 'string'
      ? { username: parsed.username, password: parsed.password }
      : null
  } catch {
    return null
  }
}

/** An `oauth-client` credential, stored as `{ "tokenUrl", "clientId", "clientSecret", "scope"? }`. */
export interface OAuthClient {
  tokenUrl: string
  clientId: string
  clientSecret: string
  scope?: string
}

export function oauthClient(value: string): OAuthClient | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const { tokenUrl, clientId, clientSecret, scope } = parsed
    if (typeof tokenUrl !== 'string' || typeof clientId !== 'string') return null
    if (typeof clientSecret !== 'string') return null
    return { tokenUrl, clientId, clientSecret, ...(typeof scope === 'string' ? { scope } : {}) }
  } catch {
    return null
  }
}

/**
 * Attach a credential VALUE to a request. Returns the request's url and headers with the
 * credential applied. `oauth-client` is not handled here: the caller exchanges it for an access
 * token first and attaches that as a bearer token.
 */
export function applyAuth(
  url: string,
  headers: Record<string, string>,
  auth: Exclude<AuthScheme, { scheme: 'oauth-client' }>,
  value: string,
): { url: string; headers: Record<string, string> } {
  switch (auth.scheme) {
    case 'bearer':
      return { url, headers: { ...headers, authorization: `Bearer ${value}` } }
    case 'basic': {
      const login = loginFields(value)
      const pair = login ? `${login.username}:${login.password}` : value
      return {
        url,
        headers: { ...headers, authorization: `Basic ${Buffer.from(pair).toString('base64')}` },
      }
    }
    case 'header':
      return { url, headers: { ...headers, [auth.name]: value } }
    case 'query': {
      const next = new URL(url)
      next.searchParams.set(auth.name, value)
      return { url: next.toString(), headers }
    }
  }
}

/** Every secret string a credential can contribute, for redaction. */
export function credentialSecrets(credentials: readonly AccessCredential[]): string[] {
  const out: string[] = []
  for (const credential of credentials) {
    out.push(credential.value)
    const login = credential.kind === 'login' ? loginFields(credential.value) : null
    if (login) out.push(login.password)
    const client = credential.kind === 'oauth-client' ? oauthClient(credential.value) : null
    if (client) out.push(client.clientSecret)
  }
  return out.filter((s) => s.length >= 4)
}

// Shapes that look like a credential even when the run never knew the value: a token the target
// shows once on a page, or mints in a response. Replaced wholesale, keeping the field name.
const TOKEN_SHAPES: ReadonlyArray<[RegExp, string]> = [
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, '***'],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{12,}/gi, '$1 ***'],
  [
    /("(?:access_token|refresh_token|id_token|api_key|apiKey|client_secret|token|secret|password)"\s*:\s*")[^"]{4,}(")/gi,
    '$1***$2',
  ],
  [/([?&](?:access_token|api_key|apikey|token|key|signature)=)[^&#\s"]{8,}/gi, '$1***'],
]

/**
 * Scrub text before it reaches the model or the result: the job's known secret values first,
 * then the platform's own redaction, then a token-shape pass for values the run never knew.
 */
export function scrub(text: string, knownSecrets: readonly string[]): string {
  let out = redact(
    text,
    [...knownSecrets].sort((a, b) => b.length - a.length),
  )
  for (const [pattern, replacement] of TOKEN_SHAPES) out = out.replace(pattern, replacement)
  return out
}
