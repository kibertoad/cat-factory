import { getReportsContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { UnavailableError, UnauthorizedError } from '@cat-factory/kernel'

/** The signed-in user, or null. Generic over the (contract-typed) env, like AccountController. */
function accountUser<E extends AppEnv>(c: Context<E>) {
  const user = c.get('user')
  return user ? { id: user.id, login: user.login, name: user.name } : null
}

const signInRequired = (): never => {
  throw new UnauthorizedError('Sign in to view reports')
}

/**
 * Reports: `GET /accounts/:accountId/reports` — cross-cutting usage analytics for an
 * account over a time window (spend per model / agent kind, and spend + run activity per
 * workspace / service / task type, plus a spend trend). Admin-gated for the same reason as
 * the operator dashboard (cross-workspace operational and cost data), and 503 when the
 * reports rollup isn't wired (tests / no store).
 *
 * `workspaceId` narrows EVERY breakdown to one board. It is authorized by the account
 * admin check alone, deliberately: an admin already sees every board's numbers in the
 * account-wide rollup, so filtering to one reveals nothing new. A board belonging to
 * another account simply matches no rows — the account scope is applied in SQL, so the
 * filter can only ever narrow within it, never escape it.
 *
 * The dual of {@link platformObservabilityController}: that answers "is the deployment
 * healthy", this answers "where are the money and the work going".
 */
export function reportsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getReportsContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired()
    const container = c.get('container')
    if (!container.reports) {
      throw new UnavailableError('Reports are not available on this deployment')
    }
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    const query = c.req.valid('query')
    return c.json(
      await container.reports.summarize(accountId, query.window ?? '7d', query.workspaceId ?? null),
      200,
    )
  })

  return app
}
