/**
 * A URL another system supplied, as an `href`, or null when it is not one this SPA may link to.
 *
 * Bound straight into `href`, a `javascript:` or `data:` value executes in the SPA's own origin
 * when clicked, which is the same boundary `resolveExternalToolUrl` draws for a resolver-supplied
 * URL and kernel's `hostMarkdown.link` draws server-side. `http:` is allowed: a deployment's own
 * internal systems are reachable, and this is a link a person clicks, not a request the platform
 * makes.
 *
 * A caller should render a refused value as plain text rather than drop it: "we will not follow
 * this link" is a fact worth showing, and a silently missing link reads as none being reported.
 */
export function externalHref(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : null
  } catch {
    // A relative or malformed value: not something to link to, and not an error either.
    return null
  }
}
