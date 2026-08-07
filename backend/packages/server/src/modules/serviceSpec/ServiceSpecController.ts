import {
  EMPTY_SERVICE_SPEC_VIEW,
  getRunSpecContract,
  getServiceSpecContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { readServiceSpec } from '@cat-factory/agents'

const EMPTY = EMPTY_SERVICE_SPEC_VIEW

/**
 * Workspace-scoped service-spec read endpoint. The prescriptive spec lives sharded in the
 * service repo under `spec/`; the SPA cannot read a repo, so this reassembles the tree from
 * the repo's DEFAULT branch (main) and serves it for the inspector's "View Requirements"
 * window. Read-only: it never writes the repo.
 *
 * It resolves the block's repo through the same `resolveRunRepoContext` seam the engine uses
 * to bind a run's pre/post-ops (installation + repo + default branch), so it is
 * runtime-symmetric: both facades wire the resolver. When GitHub isn't connected (no
 * resolver, no linked repo) or no spec exists yet, it returns `{ present: false }` so the
 * window shows an empty state instead of erroring. Mounted under `/workspaces/:workspaceId`.
 *
 * It also serves the RUN-scoped read beside it. Both are spec reads and the pair belongs
 * together precisely so nobody reaches for the wrong one: this default-branch read answers
 * "what does this service require", and `/executions/:executionId/spec` answers "what did this
 * run rule on", which is a different tree for as long as the run's pull request is open.
 */
export function serviceSpecController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getServiceSpecContract, async (c) => {
    const container = c.get('container')
    const resolve = container.resolveRunRepoContext
    if (!resolve) return c.json(EMPTY, 200)
    let ctx
    try {
      ctx = await resolve(param(c, 'workspaceId'), c.req.valid('param').blockId)
    } catch {
      // A block under no linked service throws in the resolver; treat as "no spec" for the
      // read path rather than surfacing the misconfiguration to the inspector.
      return c.json(EMPTY, 200)
    }
    if (!ctx) return c.json(EMPTY, 200)
    // `readServiceSpec` is total (every repo read is guarded), but keep a defensive fallback
    // so a transient GitHub failure can never 500 the inspector — it shows an empty state.
    try {
      return c.json(await readServiceSpec(ctx.repo, ctx.baseBranch), 200)
    } catch {
      return c.json(EMPTY, 200)
    }
  })

  // The spec ONE RUN was judged against, for the outcome card's requirement join. Delegated
  // whole to the engine's evidence loader rather than resolved here: the branch rule, the
  // tester gate and the per-run memo are the same three the verification report and
  // `GET /api/v1/runs/:runId/outcome` read through, and a second reader with its own copy of
  // any of them is how the card and the endpoint came to describe one run differently.
  buildHonoRoute(app, getRunSpecContract, async (c) => {
    const view = await c
      .get('container')
      .executionService.readRunSpec(param(c, 'workspaceId'), c.req.valid('param').executionId)
    // A run this workspace does not have is the same answer as a run whose spec cannot be read:
    // there is no tree to join against, and the card states that as `spec: 'not_read'`. It is
    // NOT a 404, because the card asks this question about a run it is already rendering.
    return c.json(view ?? EMPTY, 200)
  })

  return app
}
