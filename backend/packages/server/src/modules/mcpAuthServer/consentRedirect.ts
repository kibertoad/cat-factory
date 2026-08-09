import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'

/**
 * The page in the SPA that asks a human what an MCP host may have.
 *
 * A page in the APP rather than a route on this backend, for the same reason the consuming side's
 * vendor callback is: the decision needs a SESSION, and this URL is reached by a top-level browser
 * navigation the host triggers, which carries no bearer token. Rendering the screen server-side
 * would mean a route that cannot tell who is looking at it, and an approval taken there would be
 * an approval by nobody. The page instead re-presents the sealed request over the authenticated API
 * (`describeMcpAuthorizationContract` / `approveMcpAuthorizationContract`), where the session, the
 * board choice and the `secrets.manage` check all actually run.
 *
 * Exported so both halves derive the string from one place. The SPA page at this path
 * (`pages/mcp-authorize.vue`) is the other half, and nothing pins the two together: renaming the
 * page must change this constant too, or `GET /oauth/authorize` sends every host to a 404 while
 * everything on this side stays green.
 */
export const MCP_AUTHORIZE_PATH = '/mcp-authorize'

/**
 * Where to send the browser for consent, with the sealed request on it.
 *
 * The base is the deployment's configured app URL when it has one, and the REQUEST's own origin
 * otherwise. That fallback is right rather than lazy: a deployment serving the SPA and the API from
 * one origin (which is every default install) needs no configuration for this to work, and one
 * serving the SPA elsewhere has already had to set `APP_BASE_URL` for its invite and
 * password-reset links to arrive anywhere. Unlike the consuming side's redirect URL, no third party
 * holds this string on file, so nothing breaks if it differs between two deployments of the same
 * app: the host never sees it, the browser simply follows it.
 *
 * The sealed request rides the query string, where a browser history keeps it. It carries no
 * credential and no code (the code is minted only after a human approves), and it is useless to
 * anyone who cannot both open a session here and hold `secrets.manage` on a board.
 *
 * The path is APPENDED to the configured base rather than resolved against it, which is the same
 * join `notificationDeepLink` makes and for the same reason: `new URL('/mcp-authorize', base)`
 * resolves an ABSOLUTE path, so it keeps the base's origin and discards any path component of it. A
 * deployment serving the SPA under a prefix (`APP_BASE_URL=https://example.test/cat-factory`) would
 * have every host sent to a 404 one segment above the app, with nothing on this side failing.
 */
export function consentUrlFor<E extends AppEnv>(c: Context<E>, sealedRequest: string): string {
  const configured = c.get('container').appBaseUrl?.trim()
  const base = configured || new URL(c.req.url).origin
  const url = new URL(`${base.replace(/\/+$/, '')}${MCP_AUTHORIZE_PATH}`)
  url.searchParams.set('request', sealedRequest)
  return url.toString()
}
