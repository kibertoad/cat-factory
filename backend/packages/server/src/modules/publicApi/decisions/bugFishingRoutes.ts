import {
  addressPublicRunBugFishingFindingsContract,
  dismissPublicRunBugFishingFindingContract,
  resolvePublicRunBugFishingContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import type { Hono } from 'hono'
import type { AppEnv } from '../../../http/env.js'
import { runWithInitiator } from '../../../github/runInitiatorContext.js'
import { buildDecisionList } from './projection.js'
import { failureBody, gateDecisionAction } from './scope.js'

// The BUG-FISHING EXPEDITION's three verbs: mark findings to be addressed, dismiss one, finish
// triaging.
//
// This is the second CURATING park to become answerable here, and closing it is what removes
// `bug-fisher` from the decision surface's `unanswerable` report: until these routes existed, an
// expedition was a run a `decide` key could start, watch and only END, discarding everything it
// had caught. The one place that fact is declared is `PUBLICLY_ANSWERABLE_PARK_SURFACES`, which
// the start-surface refusal and the wait report both read, so adding the kind there is what makes
// all three agree.
//
// Reachable only through `POST /api/v1/tasks/:taskId/start`, since `bug-fisher` is
// container-backed and the jobs surface is inline-only.
//
// TWO of the three run under the run's OWN initiator, and the split is the same one `gateRoutes`
// draws: `address` creates board tasks and STARTS their runs, `resolve` advances the expedition's
// run past its step, and both must keep using the credentials the expedition was started with
// rather than silently demoting to the deployment default. `dismiss` writes the step and nothing
// else, so it has no outbound work for an initiator to credential.
//
// The marking's REQUESTER is deliberately `null` rather than anything derived from the key: a key
// is not a person, and inventing one would put a name on the expedition's record that never read
// the finding. The spawn record's `requestedAt` still says when.

export function registerBugFishingDecisionRoutes(app: Hono<AppEnv>): void {
  // Mark findings to be addressed: one bug-fix task per finding, each linked back to the
  // expedition and started immediately.
  buildHonoRoute(app, addressPublicRunBugFishingFindingsContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    const input = c.req.valid('json')
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c
        .get('container')
        .executionService.decisions.addressBugFishingFindings(
          workspaceId,
          scoped.execution.id,
          input,
          null,
        ),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Drop one finding from triage. Curation, not a resolution: the run stays exactly where it is,
  // and the finding stays on the expedition's record rather than vanishing from it.
  buildHonoRoute(app, dismissPublicRunBugFishingFindingContract, async (c) => {
    const { runId, findingId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.decisions.dismissBugFishingFinding(
        workspaceId,
        scoped.execution.id,
        findingId,
      )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Finish the expedition and advance the run past the step. Everything still unmarked stays
  // unacted on, which is why this is a separate verb rather than something `address` implies.
  buildHonoRoute(app, resolvePublicRunBugFishingContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c
        .get('container')
        .executionService.decisions.resolveBugFishing(workspaceId, scoped.execution.id),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })
}
