import type { DocumentSourceDescriptor } from '../../domain/types'
import { ValidationError } from '../../domain/errors'

// Confluence-specific pure logic, kept out of the worker so it is unit-testable
// without a live site: parsing a page id out of user input, validating/securing
// the site base URL, and converting storage-format XHTML into the lightweight
// Markdown the generic planner consumes. The fetch itself lives in the worker's
// ConfluenceProvider.

/** What the connect UI renders, and which credentials the provider needs. */
export const CONFLUENCE_DESCRIPTOR: DocumentSourceDescriptor = {
  source: 'confluence',
  label: 'Confluence',
  icon: 'i-lucide-book-open',
  credentialFields: [
    {
      key: 'baseUrl',
      label: 'Site URL',
      placeholder: 'https://your-team.atlassian.net',
      help: 'e.g. https://your-team.atlassian.net',
    },
    { key: 'accountEmail', label: 'Account email', placeholder: 'you@company.com' },
    {
      key: 'apiToken',
      label: 'API token',
      secret: true,
      placeholder: 'Paste a Confluence API token',
      help: 'Create one at id.atlassian.com → Security → API tokens',
    },
  ],
  refLabel: 'Page URL or ID',
  refPlaceholder: 'https://…/pages/12345/Title  or  12345',
}

/** Drop a trailing slash and a trailing `/wiki` so we can build paths uniformly. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/wiki$/i, '')
}

/**
 * Resolve a Confluence page id from raw user input: a bare numeric id, a modern
 * `/wiki/spaces/…/pages/<id>/…` URL, or a legacy `?pageId=<id>` URL.
 */
export function parseConfluenceRef(input: string): string | null {
  const trimmed = input.trim()
  if (/^\d+$/.test(trimmed)) return trimmed
  const pageIdParam = trimmed.match(/[?&]pageId=(\d+)/)
  if (pageIdParam) return pageIdParam[1]!
  const pathMatch = trimmed.match(/\/pages\/(?:[a-z-]+\/)?(\d+)/i)
  if (pathMatch) return pathMatch[1]!
  return null
}

/**
 * Reject hostnames that point at the worker's own network rather than a public
 * Confluence Cloud site. The provider fetches `${baseUrl}/wiki/...` with the
 * workspace's Basic-auth credentials, so an unvalidated base URL turns the worker
 * into an SSRF proxy (and leaks the API token to an internal host). This is
 * host-literal defence-in-depth — it does not stop DNS rebinding, but blocks the
 * obvious internal targets (loopback, link-local/metadata, RFC1918).
 */
function isBlockedConfluenceHost(hostname: string): boolean {
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
 * Validate a (normalized) Confluence base URL before it is stored and later
 * fetched. Requires `https`, forbids embedded credentials, and rejects
 * internal/private hosts. Throws {@link ValidationError} on anything unsafe.
 *
 * Parsed by hand (no `URL` global) so this stays in the platform-agnostic core.
 */
export function assertSafeConfluenceBaseUrl(baseUrl: string): void {
  const invalid = () => new ValidationError(`Confluence base URL is not a valid URL: '${baseUrl}'`)
  const match = baseUrl.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)/)
  if (!match) throw invalid()

  if (match[1]!.toLowerCase() !== 'https') {
    throw new ValidationError('Confluence base URL must use https')
  }
  const authority = match[2]!
  if (authority.includes('@')) {
    throw new ValidationError('Confluence base URL must not contain credentials')
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
  if (isBlockedConfluenceHost(host)) {
    throw new ValidationError('Confluence base URL must be a public host')
  }
}

/** Decode the handful of XHTML entities Confluence storage format emits. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#3?9;|&apos;/gi, "'")
}

/**
 * Convert Confluence storage-format XHTML into the lightweight Markdown the
 * generic planner/excerpt logic consumes: headings become `#`/`##`/`###`, list
 * items become `- `, and block boundaries become newlines.
 */
export function confluenceStorageToMarkdown(html: string): string {
  const withMarkers = html
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_m, c: string) => `\n# ${stripTags(c)}\n`)
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_m, c: string) => `\n## ${stripTags(c)}\n`)
    .replace(/<h[3-6]\b[^>]*>([\s\S]*?)<\/h[3-6]>/gi, (_m, c: string) => `\n### ${stripTags(c)}\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, c: string) => `\n- ${stripTags(c)}\n`)
    .replace(/<\s*(br|\/p|\/div)\s*\/?>/gi, '\n')
  return decodeEntities(stripTags(withMarkers))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Strip any remaining tags and collapse intra-line whitespace. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}
