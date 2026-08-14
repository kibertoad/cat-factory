import type { Hono, MiddlewareHandler } from 'hono'
import type { AppEnv } from './env.js'
import { param } from './params.js'
import { requireUser } from './guards.js'

/**
 * Gate an account-tier controller's OWN top-level paths on account membership.
 *
 * The account-side sibling of `mountWorkspacePermission`, and it exists for the same reason: the
 * mount is where this authorization is easy to get subtly wrong, so no controller should be spelling
 * it out. Four controllers had written the identical guard plus the identical two-line-per-resource
 * mount loop (differing only in the sign-in message), which meant a change to the membership rule
 * had to be made in four places and could silently be applied to three.
 *
 * **It takes PREFIXES, never `'*'`.** `app.route(prefix, sub)` re-registers a sub-app's `use('*')` as
 * `ALL <prefix>/*` on the parent, so a wildcard here would run against every sibling controller
 * mounted on the same prefix and authorize their routes under this one's rule.
 *
 * **Each resource is paired with its subtree**, which is the half the hand-written loops existed to
 * get right and one of them did not: `/foundational-service-suppressions` once had no entry at all,
 * leaving an account-tier opt-out list reachable by any signed-in user for any account id.
 *
 * Reads are gated as well as writes, unlike the workspace mount's default. An account tier has no
 * viewer rung to let through: a caller outside the account gets the existence-hiding 404
 * `requireMember` throws, and its catalog is not public to signed-in strangers.
 *
 * @param signInMessage What an unauthenticated caller is told to do, named per controller because it
 *   is the one part a person reads. The sign-in floor is a hard denial rather than an allow-all,
 *   including under dev-open: unlike the workspace gate, this tier never passes through anonymously.
 */
export function mountAccountMembership<E extends AppEnv>(
  app: Hono<E>,
  prefixes: readonly string[],
  signInMessage: string,
): void {
  if (prefixes.length === 0) {
    // A gated controller with no prefix would gate nothing while reading as gated, which is the
    // silent hole this helper exists to close (same rule as `mountWorkspacePermission`).
    throw new Error('mountAccountMembership: at least one path prefix is required')
  }
  const guard: MiddlewareHandler<E> = async (c, next) => {
    const user = requireUser(c, signInMessage)
    // requireMember throws NotFoundError (→ 404) when the user isn't a member.
    await c.get('container').accountService.requireMember(param(c, 'accountId'), user.id)
    await next()
  }
  for (const prefix of prefixes) {
    app.use(prefix, guard)
    app.use(`${prefix}/*`, guard)
  }
}
