import { scanRepoSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { BoardScanModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { jsonBody } from '../../infrastructure/http/validation'

/** Resolve the board-scan module or send a 503, returning null when unconfigured. */
function requireBoardScan(c: Context<AppEnv>): BoardScanModule | null {
  return c.get('container').boardScan ?? null
}

const unavailable = (c: Context<AppEnv>, message: string) =>
  c.json({ error: { code: 'unavailable', message } }, 503)

/**
 * Workspace-scoped board-scan endpoints: read the persisted repository blueprints,
 * and the "scan repository" command (decompose a repo into a service → modules
 * blueprint, optionally spawning it onto the board). Mounted under
 * `/workspaces/:workspaceId`.
 */
export function boardScanController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // ---- blueprints ---------------------------------------------------------

  app.get('/board-scan/blueprints', async (c) => {
    const boardScan = requireBoardScan(c)
    if (!boardScan) return unavailable(c, 'Board scan is not configured')
    return c.json(await boardScan.service.listBlueprints(param(c, 'workspaceId')))
  })

  app.get('/board-scan/blueprints/:id', async (c) => {
    const boardScan = requireBoardScan(c)
    if (!boardScan) return unavailable(c, 'Board scan is not configured')
    return c.json(await boardScan.service.getBlueprint(param(c, 'workspaceId'), param(c, 'id')))
  })

  app.delete('/board-scan/blueprints/:id', async (c) => {
    const boardScan = requireBoardScan(c)
    if (!boardScan) return unavailable(c, 'Board scan is not configured')
    await boardScan.service.deleteBlueprint(param(c, 'workspaceId'), param(c, 'id'))
    return c.body(null, 204)
  })

  // ---- scan ---------------------------------------------------------------

  // Kick off a scan. Requires the GitHub + container machinery to be wired;
  // otherwise the scan path is unavailable even though blueprint reads work.
  app.post('/board-scan/scans', jsonBody(scanRepoSchema), async (c) => {
    const boardScan = requireBoardScan(c)
    if (!boardScan) return unavailable(c, 'Board scan is not configured')
    if (!boardScan.service.canScan) {
      return unavailable(
        c,
        'Repository scanning needs the GitHub App and the implementation container to be configured',
      )
    }
    const result = await boardScan.service.scan(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(result, 201)
  })

  return app
}
