import {
  choosePublicRunForkContract,
  listPublicRunDecisionsContract,
  resolvePublicRunInputGateContract,
  resolvePublicRunJudgeContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { runWithInitiator } from '../../github/runInitiatorContext.js'
import { registerApprovalDecisionRoutes } from './decisions/approvalRoutes.js'
import {
  registerFollowUpDecisionRoutes,
  registerInterviewDecisionRoutes,
} from './decisions/companionRoutes.js'
import {
  registerBrainstormDecisionRoutes,
  registerClarityDecisionRoutes,
} from './decisions/dialogueRoutes.js'
import {
  registerHumanVerdictGateRoutes,
  registerPrReviewDecisionRoutes,
} from './decisions/gateRoutes.js'
import { buildDecisionList } from './decisions/projection.js'
import { registerRequirementsDecisionRoutes } from './decisions/requirementsRoutes.js'
import { failureBody, gateDecisionAction, loadScopedRun } from './decisions/scope.js'
import { authorize } from './publicApiAuth.js'

// The PUBLIC parked-decision surface (`/api/v1/runs/:runId/decisions/*`) — the external
// counterpart of every window the SPA offers a human when a run stops and waits for one.
//
// The clarification loop (reviewer raises findings → the run parks → a human answers → an
// incorporation pass folds the answers in → the run advances) used to be reachable only from the
// SPA, which is why the public surface refused any pipeline that could park at all: a headless run
// had no answerer, and a parked run waits for a human INDEFINITELY. These routes are the answerer,
// and their existence is what lets `PublicApiController` admit a parking pipeline for a
// `decide`-scope key. See `docs/initiatives/headless-clarification-loop.md` for the original loop
// and `backend/docs/adr/0043-public-decision-surface.md` for the surfaces added since.
//
// Three rules shape everything here:
//
//  1. **No parallel logic.** Every action delegates to the SAME service method the SPA controller
//     calls, so the park's CAS/approval-id arbitration, the task's merge-preset knobs (iteration
//     cap, tolerated severity) and the durable-driver signalling apply identically whichever
//     surface answers first. Racing surfaces are already arbitrated by that machinery; this
//     controller adds no locking of its own.
//  2. **Every response is the run's whole decision list.** An action's interesting outcome is what
//     the run is NOW asking (a fresh round of findings, convergence, the iteration cap), not the
//     one entity it touched — so returning the list saves the caller a follow-up read and makes
//     "the review moved on" self-evident.
//  3. **Offer only what the engine will accept.** A park is projected as the kind whose verbs
//     actually resolve it (see `decisions/projection.ts`); offering a caller a route the engine
//     refuses would leave a well-behaved integration looping on a 409.
//
// Keyed by RUN id, so one surface serves both a headless job and a board task run. The routes
// themselves live in `decisions/`, grouped by the park they answer; this file composes them and
// keeps the three surface-wide reads/actions that belong to no group.

export function publicDecisionController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  registerDecisionReadRoutes(app)
  registerRequirementsDecisionRoutes(app)
  registerClarityDecisionRoutes(app)
  registerBrainstormDecisionRoutes(app)
  registerForkDecisionRoutes(app)
  registerJudgeRoutes(app)
  registerInputGateRoutes(app)
  registerApprovalDecisionRoutes(app)
  registerPrReviewDecisionRoutes(app)
  registerHumanVerdictGateRoutes(app)
  registerFollowUpDecisionRoutes(app)
  registerInterviewDecisionRoutes(app)
  return app
}

function registerInputGateRoutes(app: Hono<AppEnv>): void {
  // Answer a run parked on the PRE-DISPATCH INPUT GATE: `recheck` after fixing the task, or
  // `proceed` to waive the findings.
  //
  // Runs under the RUN'S OWN initiator, for the same reason the fork route does: releasing the
  // park wakes the durable driver, and a board run started in the SPA carries a `usr_*` initiator
  // whose credentials the resumed work must keep using. A genuinely headless run has
  // `initiatedBy: null`, where this is a no-op.
  //
  // The waiver is recorded against no user (`null`): a key is not a person, and inventing one
  // would put a name on the record that never read the findings. `overriddenAt` still says when.
  buildHonoRoute(app, resolvePublicRunInputGateContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c
        .get('container')
        .executionService.resolveInputGate(
          workspaceId,
          scoped.execution.id,
          c.req.valid('json').choice,
          null,
        ),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })
}

function registerDecisionReadRoutes(app: Hono<AppEnv>): void {
  // List a run's currently-parked decisions. `read`-scoped: knowing that a run is waiting (and on
  // what) is a monitoring concern, so a read-only integration can surface it to a human even
  // though it cannot answer.
  buildHonoRoute(app, listPublicRunDecisionsContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) {
      return c.json(failureBody(gate.fail), gate.fail.status)
    }
    const { workspaceId } = gate.auth
    const scoped = await loadScopedRun(c, workspaceId, c.req.valid('param').runId)
    if (!scoped) {
      return c.json({ error: { code: 'not_found', message: 'Run not found' } }, 404)
    }
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })
}

function registerJudgeRoutes(app: Hono<AppEnv>): void {
  // Resolve a parked rubric verdict: proceed anyway, bounce the work back to the producing step
  // for rework, or stop the run. Delegates to the SAME `executionService.resolveJudgeDecision`
  // the SPA's judge window calls, so the park's CAS + approval-id arbitration and the task's
  // preset knobs apply identically whichever surface answers first.
  //
  // Runs under the RUN'S OWN initiator for the same reason the fork choice does: a `bounce`
  // resumes the producing step's container work, which must keep using the credentials the run
  // was started with rather than silently demoting to the deployment default.
  buildHonoRoute(app, resolvePublicRunJudgeContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c
        .get('container')
        .executionService.resolveJudgeDecision(
          workspaceId,
          scoped.execution.id,
          c.req.valid('json'),
        ),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })
}

function registerForkDecisionRoutes(app: Hono<AppEnv>): void {
  // Choose an implementation approach — a proposed fork id or the caller's own approach. The Coder
  // then re-runs with it folded in as a binding directive.
  //
  // Runs under the RUN'S OWN initiator, not the caller's — the SPA twin passes the acting user
  // (`c.get('user')?.id`) so the resumed run's container work uses their per-user credentials, and
  // an external key has no user to pass. Taking the initiator off the run rather than skipping the
  // scope entirely is what keeps the two surfaces equivalent: this route is keyed by run id and
  // deliberately accepts a BOARD task run as well as a headless job, and a board run
  // started in the SPA does carry a `usr_*` initiator whose PAT `PatPreferringAppRegistry` resolves
  // through `currentCredentialScope()`. Answering such a run over the public API must not
  // silently demote its resumed clone/push to the deployment default. A genuinely headless run has
  // `initiatedBy: null`, which is exactly the no-ambient-context case — so this is a no-op there.
  //
  // The grounded fork CHAT is deliberately not exposed: it is an interactive deliberation
  // affordance, and a headless caller already has each fork's full approach/trade-offs/risk text
  // from `GET .../decisions`.
  buildHonoRoute(app, choosePublicRunForkContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateDecisionAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await runWithInitiator({ workspaceId, initiatedBy: scoped.execution.initiatedBy }, () =>
      c
        .get('container')
        .executionService.chooseFork(workspaceId, scoped.execution.id, c.req.valid('json')),
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })
}
