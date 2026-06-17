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

/** Whether a decoded IPv4 address is loopback / link-local (metadata) / RFC1918. */
function isPrivateV4(parts: [number, number, number, number]): boolean {
  const [a, b] = parts
  if (a === 127 || a === 0 || a === 10) return true
  if (a === 169 && b === 254) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/** Parse a plain dotted-decimal IPv4 literal (each octet 0-255), or null. */
function decimalV4(host: string): [number, number, number, number] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  const c = Number(m[3])
  const d = Number(m[4])
  if (a > 255 || b > 255 || c > 255 || d > 255) return null
  return [a, b, c, d]
}

/** Extract the embedded IPv4 of an IPv4-mapped IPv6 literal (`::ffff:…`), or null. */
function mappedV4(host: string): [number, number, number, number] | null {
  // ::ffff:a.b.c.d
  const dotted = host.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (dotted) {
    const a = Number(dotted[1])
    const b = Number(dotted[2])
    const c = Number(dotted[3])
    const d = Number(dotted[4])
    if (a > 255 || b > 255 || c > 255 || d > 255) return null
    return [a, b, c, d]
  }
  // ::ffff:hhhh:hhhh
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = parseInt(hex[1] ?? '0', 16)
    const lo = parseInt(hex[2] ?? '0', 16)
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]
  }
  return null
}

/**
 * Reject hostnames that point at the worker's own network rather than a public
 * Atlassian Cloud site. A provider fetches `${baseUrl}/...` with the workspace's
 * Basic-auth credentials, so an unvalidated base URL turns the worker into an
 * SSRF proxy (and leaks the API token to an internal host). This is host-literal
 * defence-in-depth — it does not stop DNS rebinding, but blocks the obvious
 * internal targets (loopback, link-local/metadata, RFC1918) including the
 * obfuscated encodings (bare integer, hex/octal octets, IPv4-mapped IPv6) that
 * trivially bypass a naive dotted-decimal match.
 */
function isBlockedAtlassianHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.internal') || host.endsWith('.local')) return true

  // IPv6 loopback / link-local / unique-local, plus IPv4-mapped IPv6.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true
    const mapped = mappedV4(host)
    if (mapped) return isPrivateV4(mapped)
    return false
  }

  // Obfuscated numeric IPv4 forms are never a legitimate public hostname.
  // Bare integer (e.g. 2130706433 === 127.0.0.1).
  if (/^\d+$/.test(host)) return true
  const labels = host.split('.')
  for (const label of labels) {
    if (/^0x[0-9a-f]+$/.test(label)) return true // hex octet (0x7f)
    if (/^0[0-9]+$/.test(label)) return true // octal / leading-zero octet (0177)
  }

  // Standard dotted-decimal IPv4: public addresses pass, private ones blocked.
  const v4 = decimalV4(host)
  if (v4) return isPrivateV4(v4)

  // A purely numeric dotted host that is not a valid public dotted-decimal IPv4
  // is some other IP encoding we cannot vouch for — reject when in doubt.
  if (labels.length > 1 && labels.every((l) => /^\d+$/.test(l))) return true

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
