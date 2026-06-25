import { EMPTY_SERVICE_SPEC_VIEW } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { readServiceSpec } from './readServiceSpec.js'

const EMPTY = EMPTY_SERVICE_SPEC_VIEW

/**
 * Workspace-scoped service-spec read endpoint. The prescriptive spec lives sharded in the
 * service repo under `spec/`; the SPA cannot read a repo, so this reassembles the tree from
 * the repo's DEFAULT branch (main) and serves it for the inspector's "View Requirements"
 * window. Read-only: it never writes the repo.
 *
 * It resolves the block's repo through the same `resolveRunRepoContext` seam the engine uses
 * to bind a run's pre/post-ops (installation + repo + default branch), so it is
 * runtime-symmetric — both facades wire the resolver. When GitHub isn't connected (no
 * resolver, no linked repo) or no spec exists yet, it returns `{ present: false }` so the
 * window shows an empty state instead of erroring. Mounted under `/workspaces/:workspaceId`.
 */
export function serviceSpecController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/blocks/:blockId/spec', async (c) => {
    const container = c.get('container')
    const resolve = container.resolveRunRepoContext
    if (!resolve) return c.json(EMPTY)
    let ctx
    try {
      ctx = await resolve(param(c, 'workspaceId'), param(c, 'blockId'))
    } catch {
      // A block under no linked service throws in the resolver; treat as "no spec" for the
      // read path rather than surfacing the misconfiguration to the inspector.
      return c.json(EMPTY)
    }
    if (!ctx) return c.json(EMPTY)
    // `readServiceSpec` is total (every repo read is guarded), but keep a defensive fallback
    // so a transient GitHub failure can never 500 the inspector — it shows an empty state.
    try {
      return c.json(await readServiceSpec(ctx.repo, ctx.baseBranch))
    } catch {
      return c.json(EMPTY)
    }
  })

  return app
}
