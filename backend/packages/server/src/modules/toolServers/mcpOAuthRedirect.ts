import { UnavailableError } from '@cat-factory/kernel'
import type { ServerContainer } from '../../http/env.js'

/**
 * The path in the SPA that a vendor's authorization server redirects an operator's browser to.
 *
 * A page in the APP rather than a route on this backend, and that is a security decision rather
 * than a routing preference. A redirect target is reached by a third-party browser navigation,
 * which carries no bearer token, so a backend route receiving it could never tell who was
 * completing the grant; the page re-presents the vendor's `code` and `state` over the authenticated
 * API instead (`completeToolServerOAuthContract`), where the session, the user binding and the
 * `secrets.manage` re-check all apply. Exported for the docs and tests that must state the exact
 * string an operator registers at the vendor.
 */
export const MCP_OAUTH_CALLBACK_PATH = '/mcp-oauth-callback'

/**
 * The configured redirect URL, or the refusal that names what to configure.
 *
 * Deliberately not derived from the incoming request. The value has to match, to the byte, what
 * the deployment registered as its OAuth client's redirect URI, and a `Host`-derived string is a
 * different value behind every proxy, preview URL and private hostname a deployment sits behind —
 * so deriving it turns a one-time configuration step into an exchange that fails at the vendor
 * with `redirect_uri_mismatch`, which names nothing on this side.
 *
 * A 503 with its own `reason` rather than a generic unavailability, because the deployment IS
 * otherwise wired: the store exists, the declaration is sound, and one variable is missing.
 */
export function requireMcpOAuthRedirectUrl(container: ServerContainer): string {
  const url = container.mcpOAuthRedirectUrl?.trim()
  if (!url) {
    throw new UnavailableError(
      'Tool-server OAuth needs a redirect URL. Set MCP_OAUTH_REDIRECT_URL to this deployment’s ' +
        `public app URL followed by ${MCP_OAUTH_CALLBACK_PATH}, and register the same value as ` +
        'the OAuth client’s redirect URI at the vendor.',
      'mcp_oauth_redirect_url_not_configured',
    )
  }
  return url
}
