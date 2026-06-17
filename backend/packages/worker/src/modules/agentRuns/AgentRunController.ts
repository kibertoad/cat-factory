import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'

const unavailable = (c: Context<AppEnv>, message: string) =>
  c.json({ error: { code: 'unavailable', message } }, 503)

/**
 * Cross-cutting endpoints over any "agent run" (bootstrap or execution),
 * dispatching to the right service by the run's kind. Mounted under
 * `/workspaces/:workspaceId`. This is the single retry path the board uses for a
 * failed run of either flow (replacing the bootstrap-only retry route).
 */
export function agentRunController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Retry a failed run. Resolves the kind from the unified agent_runs table, then
  // re-drives via the matching service (both 409 if the run isn't `failed`).
  app.post('/agent-runs/:id/retry', async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const id = param(c, 'id')

    const ref = await container.agentRunRepository.getRef(workspaceId, id)
    if (!ref) {
      return c.json({ error: { code: 'not_found', message: `Agent run '${id}' not found` } }, 404)
    }

    if (ref.kind === 'bootstrap') {
      const bootstrap = container.bootstrap
      if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
      if (!bootstrap.service.canBootstrap) {
        return unavailable(
          c,
          'Repo bootstrapping needs the GitHub App and the implementation container to be configured',
        )
      }
      const run = await bootstrap.service.retry(workspaceId, id)
      return c.json({ kind: ref.kind, run }, 201)
    }

    const run = await container.executionService.retry(workspaceId, id)
    return c.json({ kind: ref.kind, run }, 201)
  })

  // Explicitly stop a running run (bootstrap or execution). Kills the per-run
  // container and tears down the durable driver, then marks the run terminally
  // `cancelled` so the board stops showing it as running. Resolves the kind from
  // the unified agent_runs table and dispatches to the matching service.
  app.post('/agent-runs/:id/stop', async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const id = param(c, 'id')

    const ref = await container.agentRunRepository.getRef(workspaceId, id)
    if (!ref) {
      return c.json({ error: { code: 'not_found', message: `Agent run '${id}' not found` } }, 404)
    }

    if (ref.kind === 'bootstrap') {
      const bootstrap = container.bootstrap
      if (!bootstrap) return unavailable(c, 'Repo bootstrap is not configured')
      const run = await bootstrap.service.stop(workspaceId, id)
      return c.json({ kind: ref.kind, run })
    }

    const run = await container.executionService.stopRun(workspaceId, id)
    return c.json({ kind: ref.kind, run })
  })

  return app
}
