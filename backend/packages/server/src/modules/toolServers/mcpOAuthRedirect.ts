import { UnavailableError } from '@cat-factory/kernel'
import type { ServerContainer } from '../../http/env.js'

/**
 * The path the vendor's authorization server redirects a browser back to. Fixed, and mounted at
 * the APP ROOT rather than under `/workspaces/:ws`, because the redirect URI is a string the
 * vendor has on file: it cannot carry a board id, and it cannot be behind the workspace gate a
 * third-party navigation has no way to satisfy.
 */
export const MCP_OAUTH_CALLBACK_PATH = '/mcp/oauth/callback'

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
        `public ${MCP_OAUTH_CALLBACK_PATH} URL and register the same value as the OAuth client’s ` +
        'redirect URI at the vendor.',
      'mcp_oauth_redirect_url_not_configured',
    )
  }
  return url
}
