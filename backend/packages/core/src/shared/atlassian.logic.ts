import { ValidationError } from '../domain/errors'

// Shared, source-agnostic handling of an Atlassian Cloud site base URL, used by
// every provider that fetches `${baseUrl}/...` with a workspace's Basic-auth
// credentials (Confluence pages, Jira issues, …). Normalizing and SSRF-guarding
// the stored base URL lives here so each provider's pure logic delegates to one
// vetted implementation rather than copying it.

/** Drop a trailing slash and a trailing `/wiki` so we can build paths uniformly. */
export function normalizeAtlassianBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/wiki$/i, '')
}

/**
 * Reject hostnames that point at the worker's own network rather than a public
 * Atlassian Cloud site. A provider fetches `${baseUrl}/...` with the workspace's
 * Basic-auth credentials, so an unvalidated base URL turns the worker into an
 * SSRF proxy (and leaks the API token to an internal host). This is host-literal
 * defence-in-depth — it does not stop DNS rebinding, but blocks the obvious
 * internal targets (loopback, link-local/metadata, RFC1918).
 */
function isBlockedAtlassianHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.internal') || host.endsWith('.local')) return true

  // IPv6 loopback / link-local / unique-local.
  if (host === '::1' || host === '::') return true
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true

  // IPv4 literal: block loopback, link-local (incl. cloud metadata 169.254.x.x),
  // and the RFC1918 private ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || a === 0 || a === 10) return true
    if (a === 169 && b === 254) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
  }
  return false
}

/**
 * Validate a (normalized) Atlassian base URL before it is stored and later
 * fetched. Requires `https`, forbids embedded credentials, and rejects
 * internal/private hosts. Throws {@link ValidationError} on anything unsafe.
 *
 * Parsed by hand (no `URL` global) so this stays in the platform-agnostic core.
 */
export function assertSafeAtlassianBaseUrl(baseUrl: string): void {
  const invalid = () => new ValidationError(`Atlassian base URL is not a valid URL: '${baseUrl}'`)
  const match = baseUrl.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)/)
  if (!match) throw invalid()

  if (match[1]!.toLowerCase() !== 'https') {
    throw new ValidationError('Atlassian base URL must use https')
  }
  const authority = match[2]!
  if (authority.includes('@')) {
    throw new ValidationError('Atlassian base URL must not contain credentials')
  }
  // Drop an optional `:port`, handling a bracketed IPv6 literal (`[::1]:8443`).
  let host: string
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    if (end === -1) throw invalid()
    host = authority.slice(1, end)
  } else {
    host = authority.split(':')[0]!
  }
  if (host === '') throw invalid()
  if (isBlockedAtlassianHost(host)) {
    throw new ValidationError('Atlassian base URL must be a public host')
  }
}
