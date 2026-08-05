import {
  approvePublicRunStepContract,
  rejectPublicRunStepContract,
  requestPublicRunStepChangesContract,
  resolvePublicRunAgentDecisionContract,
  resolvePublicRunStepExceededContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import type { Hono } from 'hono'
import type { AppEnv } from '../../../http/env.js'
import { runWithInitiator } from '../../../github/runInitiatorContext.js'
import { buildDecisionList } from './projection.js'
import { failureBody, gateDecisionAction, publicApiGateActor } from './scope.js'

// The GENERIC approval gate — "pause a run until a human approves" — plus the decisions an agent
// raises mid-work. Both are answered by an id the caller read from `GET .../decisions`, and both
// delegate to the SAME `StepDecisionController` methods the SPA's rail calls, so the engine's
// arbitration decides who wins when a person and an integration answer at once.
//
// Every route here runs under the RUN'S OWN initiator, for the reason the fork and judge routes
// do: releasing the park wakes the durable driver, and a board run started in the SPA carries a
// `usr_*` initiator whose per-user credentials the resumed container work must keep using.
// Answering such a run over the API must not silently demote its clone/push to the deployment
// default. A genuinely headless run has `initiatedBy: null`, where this is a no-op.
//
// What is deliberately NOT re-implemented: the SPA's `activateForInteraction` re-mint of a
// personal credential before the engine dispatches the next step. It exists so a browser client
// can be 428'd into re-prompting a human for a password, and there is no human here to prompt — a
// key-authenticated caller has no personal credential to unlock, which is the same reason the
// public start paths refuse a task pinned to an individual-usage model.

export function registerApprovalDecisionRoutes(app: Hono<AppEnv>): void {
  // Approve the gated proposal (optionally replacing it with an edited one) and advance the run.
  buildHonoRoute(app, approvePublicRunStepContract, async (c) => {
    const { runId, approvalId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c
        .get('container')
        .executionService.approveStep(
          workspaceId,
          scoped.execution.id,
          approvalId,
          { proposal: c.req.valid('json').proposal },
          publicApiGateActor(gated.auth),
        ),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Request changes: the gated step re-runs with the caller's guidance folded in.
  buildHonoRoute(app, requestPublicRunStepChangesContract, async (c) => {
    const { runId, approvalId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c
        .get('container')
        .executionService.requestStepChanges(
          workspaceId,
          scoped.execution.id,
          approvalId,
          { feedback: c.req.valid('json').feedback },
          publicApiGateActor(gated.auth),
        ),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Reject: the run stops entirely. No initiator scope — nothing is dispatched, and the terminal
  // `rejected` failure is exactly what the board offers a retry on.
  buildHonoRoute(app, rejectPublicRunStepContract, async (c) => {
    const { runId, approvalId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.rejectStep(
        workspaceId,
        scoped.execution.id,
        approvalId,
        c.req.valid('json').reason,
        publicApiGateActor(gated.auth),
      )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Resolve a companion gate parked at its automatic-rework cap. A DIFFERENT route from approve on
  // purpose: the engine refuses the generic verbs on this park (`assertNotIterativeGate`), and the
  // decision projection flags it as `exceeded` so a caller reaches for this one.
  buildHonoRoute(app, resolvePublicRunStepExceededContract, async (c) => {
    const { runId, approvalId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c
        .get('container')
        .executionService.resolveCompanionExceeded(
          workspaceId,
          scoped.execution.id,
          approvalId,
          c.req.valid('json').choice,
        ),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Answer a decision an agent raised: the asking step RE-RUNS with the choice folded in.
  buildHonoRoute(app, resolvePublicRunAgentDecisionContract, async (c) => {
    const { runId, decisionId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c
        .get('container')
        .executionService.resolveDecision(
          workspaceId,
          scoped.execution.id,
          decisionId,
          c.req.valid('json').choice,
        ),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })
}
