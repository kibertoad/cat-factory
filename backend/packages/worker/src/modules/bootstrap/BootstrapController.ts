import {
  bootstrapRepoSchema,
  createReferenceArchitectureSchema,
  updateReferenceArchitectureSchema,
} from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { BootstrapModule } from '@cat-factory/core'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { jsonBody } from '../../infrastructure/http/validation'

/** Resolve the bootstrap module or send a 503, returning null when unconfigured. */
function requireBootstrap(c: Context<AppEnv>): BootstrapModule | null {
  return c.get('container').bootstrap ?? null
}

const unavailable = (c: Context<AppEnv>, message: string) =>
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

  app.get('/bootstrap/reference-architectures', async (c) => {
    const bootstrap = requireBootstrap(c)
    if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
    return c.json(await bootstrap.service.listReferenceArchitectures(param(c, 'workspaceId')))
  })

  app.post(
    '/bootstrap/reference-architectures',
    jsonBody(createReferenceArchitectureSchema),
    async (c) => {
      const bootstrap = requireBootstrap(c)
      if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
      const created = await bootstrap.service.createReferenceArchitecture(
        param(c, 'workspaceId'),
        c.req.valid('json'),
      )
      return c.json(created, 201)
    },
  )

  app.patch(
    '/bootstrap/reference-architectures/:id',
    jsonBody(updateReferenceArchitectureSchema),
    async (c) => {
      const bootstrap = requireBootstrap(c)
      if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
      const updated = await bootstrap.service.updateReferenceArchitecture(
        param(c, 'workspaceId'),
        param(c, 'id'),
        c.req.valid('json'),
      )
      return c.json(updated)
    },
  )

  app.delete('/bootstrap/reference-architectures/:id', async (c) => {
    const bootstrap = requireBootstrap(c)
    if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
    await bootstrap.service.deleteReferenceArchitecture(param(c, 'workspaceId'), param(c, 'id'))
    return c.body(null, 204)
  })

  // ---- bootstrap jobs -----------------------------------------------------

  app.get('/bootstrap/jobs', async (c) => {
    const bootstrap = requireBootstrap(c)
    if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
    return c.json(await bootstrap.service.listJobs(param(c, 'workspaceId')))
  })

  app.get('/bootstrap/jobs/:id', async (c) => {
    const bootstrap = requireBootstrap(c)
    if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
    return c.json(await bootstrap.service.getJob(param(c, 'workspaceId'), param(c, 'id')))
  })

  // Kick off a bootstrap run. Requires the GitHub + container machinery to be
  // wired; otherwise the run path is unavailable even though CRUD works.
  app.post('/bootstrap/jobs', jsonBody(bootstrapRepoSchema), async (c) => {
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

  // Retry a failed run: spins a fresh container (and durable driver) for the same
  // target, reusing the original job's board frame. 409s if the job isn't failed.
  app.post('/bootstrap/jobs/:id/retry', async (c) => {
    const bootstrap = requireBootstrap(c)
    if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
    if (!bootstrap.service.canBootstrap) {
      return unavailable(
        c,
        'Repo bootstrapping needs the GitHub App and the implementation container to be configured',
      )
    }
    const job = await bootstrap.service.retry(param(c, 'workspaceId'), param(c, 'id'))
    return c.json(job, 201)
  })

  return app
}
