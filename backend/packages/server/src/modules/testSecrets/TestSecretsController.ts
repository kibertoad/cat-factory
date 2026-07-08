import {
  deleteServiceTestSecretsContract,
  getServiceTestSecretsContract,
  setServiceTestSecretsContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { TestSecretsService } from '@cat-factory/integrations'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the test-secrets service or send a 503, returning null when unconfigured. */
function requireTestSecrets<E extends AppEnv>(c: Context<E>): TestSecretsService | null {
  return c.get('container').testSecrets ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    {
      error: {
        code: 'unavailable',
        message: 'The sensitive test-credential store is not configured (needs ENCRYPTION_KEY)',
      },
    },
    503,
  )

/**
 * The SENSITIVE per-service test-credential store: sealed at rest, delivered to the Tester
 * out of band (never in a prompt or the telemetry snapshot). Values are write-only — the view
 * returns only the configured keys + descriptions. Mounted under `/workspaces/:workspaceId`;
 * the `:blockId` is the service-frame block. Present only when a facade wired the repository.
 */
export function testSecretsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getServiceTestSecretsContract, async (c) => {
    const svc = requireTestSecrets(c)
    if (!svc) return unavailable(c)
    return c.json(await svc.getView(param(c, 'workspaceId'), c.req.valid('param').blockId), 200)
  })

  buildHonoRoute(app, setServiceTestSecretsContract, async (c) => {
    const svc = requireTestSecrets(c)
    if (!svc) return unavailable(c)
    const view = await svc.set(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
      c.req.valid('json'),
    )
    return c.json(view, 200)
  })

  buildHonoRoute(app, deleteServiceTestSecretsContract, async (c) => {
    const svc = requireTestSecrets(c)
    if (!svc) return unavailable(c)
    await svc.deleteFor(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.body(null, 204)
  })

  return app
}
