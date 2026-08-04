import {
  approvePublicRunVisualConfirmContract,
  challengePublicRunPrReviewFindingContract,
  confirmPublicRunHumanTestContract,
  dismissPublicRunPrReviewFindingContract,
  requestPublicRunHumanTestFixContract,
  requestPublicRunVisualConfirmFixContract,
  resolvePublicRunPrReviewContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import type { Hono } from 'hono'
import type { AppEnv } from '../../../http/env.js'
import { runWithInitiator } from '../../../github/runInitiatorContext.js'
import { buildDecisionList } from './projection.js'
import { failureBody, gateDecisionAction } from './scope.js'

// The three CONTAINER-BACKED parks: the PR deep review's finding curation, and the two
// human-verdict gates (human-test, visual-confirmation).
//
// All three are reachable only through `POST /api/v1/tasks/:taskId/start`, since each is produced
// by a container step and the jobs surface is inline-only. That is also why every route here runs
// under the run's own initiator: resolving any of them can dispatch a container agent (a fixer, a
// challenge investigator) or write to the pull request, and that work must keep using the
// credentials the run was started with rather than the deployment default.
//
// The human-verdict gates are addressed by RUN, not by the parked step: their service methods are
// block-scoped (the SPA drives them from the task's window), and the run's anchor block is exactly
// what this surface already resolved to gate the call.

export function registerPrReviewDecisionRoutes(app: Hono<AppEnv>): void {
  // Resolve the parked review with the curated selection. `fix` and `post` act on the real pull
  // request — the one place this surface has an effect outside the platform.
  buildHonoRoute(app, resolvePublicRunPrReviewContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    // The public body leaves both fields plainly optional (a schema `default` on a REQUEST field
    // emits four SDKs whose types insist on a value the API does not require), so the same
    // fallbacks the internal schema declares are applied here.
    const { action, findingIds } = c.req.valid('json')
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c.get('container').executionService.resolvePrReview(workspaceId, scoped.execution.id, {
        action: action ?? 'finish',
        findingIds: findingIds ?? [],
      }),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Drop one finding from the review entirely. Curation, not a resolution: the run stays parked.
  buildHonoRoute(app, dismissPublicRunPrReviewFindingContract, async (c) => {
    const { runId, findingId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.dismissPrReviewFinding(workspaceId, scoped.execution.id, findingId)
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Challenge one finding: dispatch the read-only investigator to re-examine it. The review
  // returns to `awaiting_selection` carrying the verdict, so the caller polls for the outcome.
  buildHonoRoute(app, challengePublicRunPrReviewFindingContract, async (c) => {
    const { runId, findingId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c
        .get('container')
        .executionService.challengePrReviewFinding(
          workspaceId,
          scoped.execution.id,
          findingId,
          c.req.valid('json'),
        ),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })
}

export function registerHumanVerdictGateRoutes(app: Hono<AppEnv>): void {
  // Human-test: the change works. Tear the ephemeral environment down and advance the run.
  buildHonoRoute(app, confirmPublicRunHumanTestContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c.get('container').executionService.humanTest.confirm(workspaceId, scoped.blockId),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Human-test: submit findings and dispatch the fixer, then rebuild the environment.
  buildHonoRoute(app, requestPublicRunHumanTestFixContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c
        .get('container')
        .executionService.humanTest.requestFix(
          workspaceId,
          scoped.blockId,
          c.req.valid('json').findings,
        ),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Visual confirmation: the screenshots match. Advance the run.
  buildHonoRoute(app, approvePublicRunVisualConfirmContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c.get('container').executionService.visualConfirm.approve(workspaceId, scoped.blockId),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Visual confirmation: submit findings and dispatch the fixer, then re-park.
  buildHonoRoute(app, requestPublicRunVisualConfirmFixContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c
        .get('container')
        .executionService.visualConfirm.requestFix(
          workspaceId,
          scoped.blockId,
          c.req.valid('json').findings,
        ),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })
}
