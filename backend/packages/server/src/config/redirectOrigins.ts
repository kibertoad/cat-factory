import { ENV_HELP, configProblem } from './problems.js'

// `AUTH_ALLOWED_REDIRECT_ORIGINS` parsing, shared by every facade's auth config.
//
// It is one CSV split and one normalization, and it lives here rather than in each facade for the
// reason the value itself exists: the list is the ONLY thing standing between a cross-origin SPA
// and a post-login landing page that never receives its token (see `pickPostLoginRedirect`, which
// hands the session token to the landing URL's fragment). Two copies of the parse are two chances
// for one facade to admit an entry the other refuses.

/**
 * The allow-listed post-login redirect ORIGINS, normalized to the exact string an incoming
 * redirect's `URL.origin` is compared against (`https://app.example.com`, port included when it
 * is not the scheme default).
 *
 * An entry that is not a parseable http(s) URL FAILS THE BOOT rather than being kept verbatim.
 * A verbatim entry can never equal an `origin`, so `AUTH_ALLOWED_REDIRECT_ORIGINS=app.example.com`
 * used to disable the allowance in full silence: the operator sees a login that lands on the API
 * host instead of their SPA, with nothing anywhere naming the typo. The variable is optional; what
 * is not optional is that a value SET means what it says.
 */
export function resolveAllowedRedirectOrigins(raw: string | undefined): string[] {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  return entries.map((entry) => {
    const parsed = parseOrigin(entry)
    if (!parsed) {
      throw configProblem({
        key: 'AUTH_ALLOWED_REDIRECT_ORIGINS',
        summary: ENV_HELP.AUTH_ALLOWED_REDIRECT_ORIGINS.summary,
        remedy:
          `'${entry}' is not an http(s) origin, so it could never match a post-login redirect. ` +
          ENV_HELP.AUTH_ALLOWED_REDIRECT_ORIGINS.remedy,
        docsUrl: ENV_HELP.AUTH_ALLOWED_REDIRECT_ORIGINS.docsUrl,
      })
    }
    return parsed
  })
}

/** The `URL.origin` of an http(s) entry, or null when the entry is neither. */
function parseOrigin(entry: string): string | null {
  let url: URL
  try {
    url = new URL(entry)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // `origin` is 'null' for a URL with no host (opaque origins), which no redirect can match.
  return url.origin === 'null' ? null : url.origin
}
