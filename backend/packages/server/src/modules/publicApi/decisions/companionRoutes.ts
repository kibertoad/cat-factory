import {
  answerPublicRunFollowUpContract,
  answerPublicRunInterviewContract,
  continuePublicRunInterviewContract,
  dismissPublicRunFollowUpContract,
  filePublicRunFollowUpContract,
  proceedPublicRunInterviewContract,
  sendBackPublicRunFollowUpContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import type { Hono } from 'hono'
import type { AppEnv } from '../../../http/env.js'
import { runWithInitiator } from '../../../github/runInitiatorContext.js'
import { buildDecisionList } from './projection.js'
import { failureBody, gateDecisionAction, gateInterviewAction } from './scope.js'

// The two parks that ride `step.approval` and were reachable only from the app: FOLLOW-UP TRIAGE
// (the Coder's forward-looking items) and the INTERVIEW gates (the planning and document
// interviewers, plus any a deployment registers).
//
// Grouped together because they share the shape that separates them from every other file here:
// each is a MULTI-TURN loop that can send the same step back to work.
//
// WHICH ROUTES CARRY THE RUN'S OWN INITIATOR, and why the split is not where it looks. Every
// follow-up verb does, including the ones that read like pure recording: deciding the LAST
// undecided item is what releases the park, and the release either loops the Coder's container or
// advances onto the next step, so `dismiss` can start container work exactly as `send-back` can.
// Getting this wrong is silent: the resumed clone/push quietly demotes to the deployment default
// instead of the credentials the run was started with. `file` additionally writes to the tracker
// on its way through. On the interview side only `continue` and `proceed` carry it: they wake the
// durable driver, where `answer` writes the gate's entity and stops there by design.
//
// Both are reachable only through `POST /api/v1/tasks/:taskId/start`. The follow-up companion
// rides a container Coder step, and while an interviewer is an INLINE step, both built-in
// interview gates belong to board-anchored work (an initiative, a document task) that the
// inline-only jobs surface does not create.

export function registerFollowUpDecisionRoutes(app: Hono<AppEnv>): void {
  // File a follow-up as a tracker issue. Not idempotent by construction: the ticket is created
  // before the item is marked, so a retry after a failure part-way files a second issue. That is
  // the engine's own behaviour on this path (the SPA button has the same property) and it is not
  // re-implemented here; see the no-parallel-logic rule at the top of `PublicDecisionController`.
  //
  // A workspace with no tracker wired is a 409 from the service, not a 503: the run is answerable,
  // this one VERB is not, and the caller's remedy is a different verb rather than an operator
  // wiring something.
  buildHonoRoute(app, filePublicRunFollowUpContract, async (c) => {
    const { runId, itemId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c.get('container').executionService.fileFollowUp(workspaceId, scoped.execution.id, itemId),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Send a follow-up back to the Coder: it is folded into another Coder pass.
  buildHonoRoute(app, sendBackPublicRunFollowUpContract, async (c) => {
    const { runId, itemId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c.get('container').executionService.queueFollowUp(workspaceId, scoped.execution.id, itemId),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Answer a question item; the answer steers the Coder's next pass.
  buildHonoRoute(app, answerPublicRunFollowUpContract, async (c) => {
    const { runId, itemId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    const { answer } = c.req.valid('json')
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c
        .get('container')
        .executionService.answerFollowUp(workspaceId, scoped.execution.id, itemId, answer),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Wave an item off. The verb with nothing outbound of its own, and still the one worth reading
  // the header note about: dismissing the last undecided item releases the park, and a park
  // released with nothing to send back ADVANCES onto the next step's container work.
  buildHonoRoute(app, dismissPublicRunFollowUpContract, async (c) => {
    const { runId, itemId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c.get('container').executionService.dismissFollowUp(workspaceId, scoped.execution.id, itemId),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })
}

export function registerInterviewDecisionRoutes(app: Hono<AppEnv>): void {
  // Record one answer. Deliberately does NOT resume: the interviewer re-runs on `continue`, so a
  // per-answer resume would spend an interviewer pass per question.
  buildHonoRoute(app, answerPublicRunInterviewContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateInterviewAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped, gate } = gated
    const { questionId, answer } = c.req.valid('json')
    await gate.answer(workspaceId, scoped.blockId, questionId, answer)
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Submit the answers and let the interviewer ask more. Runs under the run's own initiator: this
  // wakes the durable driver, which re-enters the gate and carries the run onward from there.
  buildHonoRoute(app, continuePublicRunInterviewContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateInterviewAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped, gate } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      gate.continue(workspaceId, scoped.blockId),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Converge on the answers so far and advance. The interviewer still runs one final pass (it has
  // to synthesize its brief), which is why this is asynchronous like `continue` rather than a
  // plain state flip.
  buildHonoRoute(app, proceedPublicRunInterviewContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateInterviewAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped, gate } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      gate.proceed(workspaceId, scoped.blockId),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })
}
