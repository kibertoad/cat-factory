/**
 * Where the browser reloads to once a sign-in succeeds.
 *
 * Every sign-in path reloads rather than routing, because the app has to boot with the new session
 * rather than patch itself around it. What it reloads TO is the question this answers, and the
 * naive `location.pathname` gets it wrong: the login screen renders at whatever URL the person
 * arrived at, so the query string belongs to the destination, not to the sign-in. Dropping it
 * silently strands any flow that carries its subject there. The MCP consent screen is the case that
 * bites hardest (`/mcp-authorize?request=<sealed>`): signing in first is the COMMON path for a
 * first connect, and landing back with no `request` leaves a person looking at "this page was
 * opened without an authorization request" with no way forward except restarting from the host.
 *
 * `invite` is the one parameter dropped, and it is dropped because it has already been SPENT: the
 * signup call consumed it, so keeping it would leave a consumed token in the address bar and in
 * every place a URL gets pasted. Everything else is the destination's business, not this module's,
 * which is why the rule is a named exception rather than an allowlist nobody remembers to extend.
 */
const SPENT_PARAMS = ['invite']

/**
 * The post-sign-in URL for one location: its path, its query minus the spent parameters, and no
 * fragment (nothing in this app puts state there, and a stale one would scroll to nowhere).
 */
export function postSignInUrl(location: { pathname: string; search: string }): string {
  const params = new URLSearchParams(location.search)
  for (const spent of SPENT_PARAMS) params.delete(spent)
  const query = params.toString()
  return query ? `${location.pathname}?${query}` : location.pathname
}
