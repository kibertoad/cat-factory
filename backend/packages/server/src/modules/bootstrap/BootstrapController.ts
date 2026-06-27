import {
  createReferenceArchitectureContract,
  deleteReferenceArchitectureContract,
  getBootstrapJobContract,
  listBootstrapJobsContract,
  listReferenceArchitecturesContract,
  startBootstrapJobContract,
  updateReferenceArchitectureContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { BootstrapModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the bootstrap module or send a 503, returning null when unconfigured. */
function requireBootstrap<E extends AppEnv>(c: Context<E>): BootstrapModule | null {
  return c.get('container').bootstrap ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>, message: string) =>
  c.json({ error: { code: 'unavailable', message } }, 503)

/**
 * Workspace-scoped repo-bootstrap endpoints: CRUD over the managed reference
 * architecture list, and the "bootstrap repo" task (create a new repo from a
 * reference architecture and run the bootstrapper agent in a container). Mounted
 * under `/workspaces/:workspaceId`.
 */
export function bootstrapController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // ---- reference architectures -------------------------------------------

  buildHonoRoute(app, listReferenceArchitecturesContract, async (c) => {
    const bootstrap = requireBootstrap(c)
    if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
    return c.json(await bootstrap.service.listReferenceArchitectures(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, createReferenceArchitectureContract, async (c) => {
    const bootstrap = requireBootstrap(c)
    if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
    const created = await bootstrap.service.createReferenceArchitecture(
      param(c, 'workspaceId'),
      c.req.valid('json'),
    )
    return c.json(created, 201)
  })

  buildHonoRoute(app, updateReferenceArchitectureContract, async (c) => {
    const bootstrap = requireBootstrap(c)
    if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
    const updated = await bootstrap.service.updateReferenceArchitecture(
      param(c, 'workspaceId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    return c.json(updated, 200)
  })

  buildHonoRoute(app, deleteReferenceArchitectureContract, async (c) => {
    const bootstrap = requireBootstrap(c)
    if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
    await bootstrap.service.deleteReferenceArchitecture(
      param(c, 'workspaceId'),
      c.req.valid('param').id,
    )
    return c.body(null, 204)
  })

  // ---- bootstrap jobs -----------------------------------------------------

  buildHonoRoute(app, listBootstrapJobsContract, async (c) => {
    const bootstrap = requireBootstrap(c)
    if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
    return c.json(await bootstrap.service.listJobs(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, getBootstrapJobContract, async (c) => {
    const bootstrap = requireBootstrap(c)
    if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
    return c.json(
      await bootstrap.service.getJob(param(c, 'workspaceId'), c.req.valid('param').id),
      200,
    )
  })

  // Kick off a bootstrap run. Requires the GitHub + container machinery to be
  // wired; otherwise the run path is unavailable even though CRUD works.
  buildHonoRoute(app, startBootstrapJobContract, async (c) => {
    const bootstrap = requireBootstrap(c)
    if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
    if (!bootstrap.service.canBootstrap) {
      return unavailable(
        c,
        'Repo bootstrapping needs the GitHub App and the implementation container to be configured',
      )
    }
    const job = await bootstrap.service.bootstrap(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(job, 201)
  })

  // Retrying a failed run goes through the unified `POST /agent-runs/:id/retry`
  // (see AgentRunController), which resolves the kind and re-drives this flow.

  return app
}
