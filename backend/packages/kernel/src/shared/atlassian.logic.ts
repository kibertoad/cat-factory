import { ValidationError } from '../domain/errors.js'
import { isBlockedPrivateHost } from './ip-host.logic.js'

// Shared, source-agnostic handling of an Atlassian Cloud site base URL, used by
// every provider that fetches `${baseUrl}/...` with a workspace's Basic-auth
// credentials (Confluence pages, Jira issues, …). Normalizing and SSRF-guarding
// the stored base URL lives here so each provider's pure logic delegates to one
// vetted implementation rather than copying it. The host-literal SSRF classifier
// itself is the shared `ip-host.logic` one (see {@link isBlockedPrivateHost}).

/** Drop a trailing slash and a trailing `/wiki` so we can build paths uniformly. */
export function normalizeAtlassianBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/wiki$/i, '')
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
  if (isBlockedPrivateHost(host)) {
    throw new ValidationError('Atlassian base URL must be a public host')
  }
}
