import { assertSafePublicUrl } from './url-guard.js'

// Shared, source-agnostic handling of an Atlassian Cloud site base URL, used by
// every provider that fetches `${baseUrl}/...` with a workspace's Basic-auth
// credentials (Confluence pages, Jira issues, …). Normalizing and SSRF-guarding
// the stored base URL lives here so each provider's pure logic delegates to one
// vetted implementation rather than copying it. The guard itself is the shared
// `url-guard.logic` one, under its strict default policy.

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
 * internal/private hosts, throwing a `ValidationError` on anything unsafe.
 *
 * A thin call rather than its own parse: an Atlassian site is the strict policy
 * with its own wording, and a second implementation of "which host is this
 * really" is a second place for a bypass to survive.
 */
export function assertSafeAtlassianBaseUrl(baseUrl: string): void {
  assertSafePublicUrl(baseUrl, { subject: 'Atlassian', label: 'base URL' })
}
