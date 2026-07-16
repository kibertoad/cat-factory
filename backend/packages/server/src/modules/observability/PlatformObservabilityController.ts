import { getPlatformObservabilityContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'

/** The signed-in user, or null. Generic over the (contract-typed) env, like AccountController. */
function accountUser<E extends AppEnv>(c: Context<E>) {
  const user = c.get('user')
  return user ? { id: user.id, login: user.login, name: user.name } : null
}

const signInRequired = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unauthorized', message: 'Sign in to view platform observability' } },
    401,
  )

/**
 * Platform-operator observability: `GET /accounts/:accountId/observability/platform` — the
 * deployment-level aggregate health of an account's runs (outcomes, failure taxonomy,
 * live/parked depth, duration + trend) over a time window. Admin-gated (cross-workspace
 * operational data), and 503 when the platform-metrics rollup isn't wired (tests / no store).
 *
 * The dual of the per-run observability endpoints in ExecutionController: those answer
 * "what did THIS run do"; this answers "how is the deployment doing".
 */
export function platformObservabilityController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getPlatformObservabilityContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.platformObservability) {
      return c.json(
        {
          error: {
            code: 'unavailable',
            message: 'Platform observability is not available on this deployment',
          },
        },
        503,
      )
    }
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    const window = c.req.valid('query').window ?? '24h'
    return c.json(await container.platformObservability.summarize(accountId, window), 200)
  })

  return app
}
