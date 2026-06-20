import type { DocumentSearchResult, DocumentSourceDescriptor } from '@cat-factory/kernel'
import { assertSafeAtlassianBaseUrl, normalizeAtlassianBaseUrl } from '@cat-factory/kernel'

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
  searchable: true,
}

/** Escape a user string for embedding inside a CQL double-quoted literal. */
function escapeCql(query: string): string {
  return query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Build the CQL for a free-text page search: match the term anywhere in a page's
 * text, newest first. Confluence's `text ~` is a fuzzy/word search, which is
 * exactly what a "find a page" box wants.
 */
export function buildConfluenceSearchCql(query: string): string {
  return `type = page AND text ~ "${escapeCql(query.trim())}" ORDER BY lastmodified DESC`
}

interface ConfluenceSearchResponse {
  results?: {
    id?: string
    content?: { id?: string; title?: string; type?: string }
    title?: string
    _links?: { webui?: string }
  }[]
  _links?: { base?: string }
}

/**
 * Map a Confluence search response into lean hits. The endpoint nests the page
 * under `content` (search API) or returns it flat (content/search API); we read
 * either. URLs are resolved against the response's `base`, falling back to the
 * site's `/wiki` base when absent.
 */
export function parseConfluenceSearchResults(
  json: unknown,
  fallbackBase: string,
): DocumentSearchResult[] {
  const body = (json ?? {}) as ConfluenceSearchResponse
  const base = body._links?.base ?? `${fallbackBase.replace(/\/+$/, '')}/wiki`
  const out: DocumentSearchResult[] = []
  for (const row of Array.isArray(body.results) ? body.results : []) {
    const content = row.content ?? row
    const id = content.id
    if (!id) continue
    const webui = row._links?.webui ?? ''
    out.push({
      source: 'confluence',
      externalId: id,
      title: content.title ?? '(untitled)',
      url: webui ? `${base}${webui}` : `${base}/pages/${id}`,
      excerpt: '',
    })
  }
  return out
}

/** Drop a trailing slash and a trailing `/wiki` so we can build paths uniformly. */
export function normalizeBaseUrl(baseUrl: string): string {
  return normalizeAtlassianBaseUrl(baseUrl)
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
 * Validate a (normalized) Confluence base URL before it is stored and later
 * fetched. Delegates to the shared Atlassian guard (`https`-only, no embedded
 * credentials, no internal/private hosts), throwing {@link ValidationError} on
 * anything unsafe.
 */
export function assertSafeConfluenceBaseUrl(baseUrl: string): void {
  assertSafeAtlassianBaseUrl(baseUrl)
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
