import type { Context } from 'hono'
import { appBaseUrlFor } from '../../http/appBaseUrl.js'
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
const MCP_AUTHORIZE_PATH = '/mcp-authorize'

/**
 * Where to send the browser for consent, with the sealed request on it, under the app's base URL
 * (`appBaseUrlFor`). No third party holds this string on file, so nothing breaks if it differs
 * between two deployments of the same app: the host never sees it, the browser simply follows it.
 *
 * The sealed request rides the query string, where a browser history keeps it. It carries no
 * credential and no code (the code is minted only after a human approves), and it is useless to
 * anyone who cannot both open a session here and hold `secrets.manage` on a board.
 */
export function consentUrlFor<E extends AppEnv>(c: Context<E>, sealedRequest: string): string {
  const url = new URL(`${appBaseUrlFor(c)}${MCP_AUTHORIZE_PATH}`)
  url.searchParams.set('request', sealedRequest)
  return url.toString()
}
