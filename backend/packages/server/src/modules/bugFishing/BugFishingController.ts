import {
  addressBugFishingFindingsContract,
  dismissBugFishingFindingContract,
  getBugFishingContract,
  resolveBugFishingContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { runWithInitiator } from '../../github/runInitiatorContext.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/**
 * Workspace-scoped BUG-FISHING EXPEDITION endpoints. The read-only `bug-fisher` agent reads the
 * service's codebase once per ANGLE and reports what each angle caught; the run then parks for a
 * human to finish triaging. The read returns the run's active expedition state (null when no
 * `bug-fisher` step carries one); `address` marks findings and spawns a bug-fix task for each;
 * `dismiss` drops one from triage without removing it from the record; `resolve` finishes a
 * parked expedition and advances the run. Mounted under `/workspaces/:workspaceId`.
 *
 * `address` is deliberately NOT gated on the run being parked — see the route contract.
 */
export function bugFishingController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The run's active expedition state (null when no bug-fisher step carries one).
  buildHonoRoute(app, getBugFishingContract, async (c) => {
    const state = await c
      .get('container')
      .executionService.decisions.getBugFishing(
        param(c, 'workspaceId'),
        c.req.valid('param').executionId,
      )
    return c.json(state, 200)
  })

  // Mark findings to be addressed: one bug-fix task per finding, linked to the expedition. Runs
  // under the acting user's ambient context like every other run-driving endpoint — each spawn
  // STARTS a run, which mints tokens and is attributed to whoever marked the finding.
  buildHonoRoute(app, addressBugFishingFindingsContract, async (c) => {
    const { executionId } = c.req.valid('param')
    const input = c.req.valid('json')
    const userId = c.get('user')?.id
    const state = await runWithInitiator(
      { workspaceId: param(c, 'workspaceId'), initiatedBy: userId },
      () =>
        c
          .get('container')
          .executionService.decisions.addressBugFishingFindings(
            param(c, 'workspaceId'),
            executionId,
            input,
            userId ?? null,
          ),
    )
    return c.json(state, 200)
  })

  // Dismiss a finding (curation, not a resolution — the run stays exactly where it is).
  buildHonoRoute(app, dismissBugFishingFindingContract, async (c) => {
    const { executionId, findingId } = c.req.valid('param')
    const state = await c
      .get('container')
      .executionService.decisions.dismissBugFishingFinding(
        param(c, 'workspaceId'),
        executionId,
        findingId,
      )
    return c.json(state, 200)
  })

  // Finish a parked expedition: the human is done triaging, so advance the run past the step.
  buildHonoRoute(app, resolveBugFishingContract, async (c) => {
    const { executionId } = c.req.valid('param')
    const userId = c.get('user')?.id
    const state = await runWithInitiator(
      { workspaceId: param(c, 'workspaceId'), initiatedBy: userId },
      () =>
        c
          .get('container')
          .executionService.decisions.resolveBugFishing(param(c, 'workspaceId'), executionId),
    )
    return c.json(state, 200)
  })

  return app
}
