import { getConnInfo } from '@hono/node-server/conninfo'
import type { AppEnv, AuthConfig } from '@cat-factory/server'
import { forwardedClientAddress } from '@cat-factory/server'
import type { Context } from 'hono'

/**
 * This facade's answer to "where did this request come from", read by the password throttle
 * (SEC-4).
 *
 * The socket peer by default, because on a bare Node deployment every forwarded header is
 * attacker-supplied and a client-chosen address means unlimited fresh throttle buckets (plus
 * the ability to pin someone else's). With `AUTH_TRUST_PROXY=true` the operator declares that
 * a proxy they control terminates every request, and we read the `x-forwarded-for` hop that
 * chain appended.
 *
 * `x-forwarded-for` ALONE, never `cf-connecting-ip`: nginx, Caddy, ALB and HAProxy rewrite
 * the former and forward every other header untouched, so a Cloudflare-specific header stays
 * fully client-controlled behind a generic proxy. Only the Worker facade may read it, where
 * the edge injects and overwrites it.
 */
export function makeNodeClientAddressResolver(
  auth: Pick<AuthConfig, 'trustProxyHeaders' | 'trustedProxyHops'>,
): (c: Context<AppEnv>) => string | undefined {
  return (c) => {
    if (auth.trustProxyHeaders) {
      const forwarded = forwardedClientAddress(
        c.req.header('x-forwarded-for'),
        auth.trustedProxyHops,
      )
      // A chain that does not match the declared topology is no evidence about the client, so
      // fall through to the peer rather than trusting whatever arrived.
      if (forwarded) return forwarded
    }
    try {
      return getConnInfo(c).remote.address
    } catch {
      // A request with no live socket (an in-process test `app.request`) has no peer address;
      // `undefined` is the true answer, not an error to surface.
      return undefined
    }
  }
}
