import {
  choosePublicRunForkContract,
  resolvePublicRunInputGateContract,
  resolvePublicRunJudgeContract,
  incorporatePublicRunRequirementsContract,
  listPublicRunDecisionsContract,
  proceedPublicRunRequirementsContract,
  replyPublicRunFindingContract,
  reReviewPublicRunRequirementsContract,
  resolvePublicRunRequirementsExceededContract,
  setPublicRunFindingStatusContract,
  type ExecutionInstance,
  type ForkDecisionStepState,
  type JudgeStepState,
  type PublicDecision,
  type PublicDecisionList,
  type RequirementReview,
  type RunInputGate,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { RequirementsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { runWithInitiator } from '../../github/runInitiatorContext.js'
import { authorize } from './publicApiAuth.js'

// The PUBLIC parked-decision surface (`/api/v1/runs/:runId/decisions/*`) — the external
// counterpart of the SPA's requirements-review and fork-decision windows.
//
// The clarification loop (reviewer raises findings → the run parks → a human answers → an
// incorporation pass folds the answers in → the run advances) used to be reachable only from the
// SPA, which is why the public surface refused any pipeline that could park at all: a headless run
// had no answerer, and a parked run waits for a human INDEFINITELY. These routes are the answerer,
// and their existence is what lets `PublicApiController` admit a parking pipeline for a
// `decide`-scope key. See `docs/initiatives/headless-clarification-loop.md`.
//
// Two rules shape everything here:
//
//  1. **No parallel logic.** Every action delegates to the SAME service method the SPA controller
//     calls (`requirements.service` / `executionService.requirementsReview` /
//     `executionService.chooseFork`), so the park's CAS/approval-id arbitration, the task's
//     merge-preset knobs (iteration cap, tolerated severity) and the durable-driver signalling
//     apply identically whichever surface answers first. Racing surfaces are already arbitrated by
//     that machinery; this controller adds no locking of its own.
//  2. **Every response is the run's whole decision list.** An action's interesting outcome is what
//     the run is NOW asking (a fresh round of findings, convergence, the iteration cap), not the
//     one entity it touched — so returning the list saves the caller a follow-up read and makes
//     "the review moved on" self-evident.
//
// Keyed by RUN id, so one surface serves both a headless job and a board task run.

/** A run resolved for the caller's key, with the block it is anchored on. */
interface ScopedRun {
  execution: ExecutionInstance
  /** The run's anchor block id — a board task, or a headless job anchor. */
  blockId: string
}

/**
 * Load a run by id for an authenticated key, scoped to the key's workspace. Accepts BOTH shapes the
 * public surface can create: a headless job anchor (`getInternalTask`) and an ordinary board
 * task (`getServiceTask`) — their union is exactly the set of runs this key may already read
 * through `GET /api/v1/jobs/:id` and `GET /api/v1/tasks/:taskId/run`, so nothing new is exposed.
 * Anything else in the workspace (or in another workspace) is a 404.
 */
async function loadScopedRun<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  runId: string,
): Promise<ScopedRun | null> {
  const container = c.get('container')
  const execution = await container.executionRepository.get(workspaceId, runId)
  if (!execution) return null
  const task = await container.boardService.getServiceTask(workspaceId, execution.blockId)
  if (task) return { execution, blockId: execution.blockId }
  const anchor = await container.boardService.getInternalTask(workspaceId, execution.blockId)
  return anchor ? { execution, blockId: execution.blockId } : null
}

/** Project a live requirements review onto the external decision resource. */
function toRequirementsDecision(review: RequirementReview): PublicDecision {
  return {
    kind: 'requirements-review',
    reviewId: review.id,
    taskId: review.blockId,
    status: review.status,
    iteration: review.iteration ?? 1,
    maxIterations: review.maxIterations ?? 1,
    findings: review.items.map((item) => ({
      itemId: item.id,
      category: item.category,
      severity: item.severity,
      title: item.title,
      detail: item.detail,
      status: item.status,
      reply: item.reply,
    })),
    incorporatedRequirements: review.incorporatedRequirements,
  }
}

/** Project a run's fork-decision step state onto the external decision resource. */
function toForkDecision(state: ForkDecisionStepState): PublicDecision {
  return {
    kind: 'fork',
    status: state.status,
    seamSummary: state.seamSummary ?? null,
    forks: state.forks ?? [],
  }
}

/**
 * Project a run's JUDGE step state onto the external decision resource. The rubric body is
 * deliberately omitted (see `publicJudgeDecisionSchema`) — a caller answers the findings.
 */
function toJudgeDecision(stepKind: string, state: JudgeStepState): PublicDecision {
  return {
    kind: 'judge',
    stepKind,
    status: state.status,
    rubricId: state.rubricId ?? null,
    rubricName: state.rubricName ?? null,
    threshold: state.threshold ?? null,
    verdict: state.verdict ?? null,
    bounces: state.bounces ?? 0,
    maxBounces: state.maxBounces ?? 0,
  }
}

/**
 * Whether a judge state is something the caller can still act on. `awaiting_decision` is the
 * park; `evaluating`/`bouncing` are in flight and worth surfacing so a poller sees progress
 * rather than an empty list that reads as "nothing is happening". A `passed`/`failed`/`skipped`
 * judge is settled and carries no question.
 */
function isLiveJudge(state: JudgeStepState): boolean {
  return (
    state.status === 'awaiting_decision' ||
    state.status === 'evaluating' ||
    state.status === 'bouncing'
  )
}

/**
 * Whether a requirements review is something the caller can still act on. A settled review
 * (`incorporated`) is history — it is the document downstream agents implement, not a question —
 * so it is dropped from the list rather than presented as answerable. `incorporating`/`reviewing`
 * ARE listed: the driver is mid-cycle and the caller should see that its answers are in flight
 * instead of an empty list that reads as "nothing is happening".
 */
function isLiveReview(review: RequirementReview): boolean {
  return review.status !== 'incorporated'
}

/**
 * Whether the fork state is something the caller can still act on. `awaiting_choice` is the park;
 * `proposing`/`answering` are in-flight and worth surfacing so a poller sees progress. A `chosen`,
 * `single_path` or `skipped` state is settled and carries no question.
 */
function isLiveFork(state: ForkDecisionStepState): boolean {
  return (
    state.status === 'awaiting_choice' ||
    state.status === 'proposing' ||
    state.status === 'answering'
  )
}

/**
 * Project the PRE-DISPATCH INPUT GATE's verdict for an external caller. The issue CODES are the same
 * closed vocabulary the SPA renders, so an integration maps them to its own copy (or hands them to
 * whoever filed the ticket) rather than parsing our prose.
 */
function toInputGateDecision(gate: RunInputGate): PublicDecision {
  return {
    kind: 'input-gate',
    status: gate.status,
    mode: gate.mode,
    issues: gate.issues,
    checkedAt: gate.checkedAt,
  }
}

/**
 * Whether the gate's verdict is something the caller still has to act on. ONLY `blocked`, which is
 * narrower than the other three predicates here on purpose: `off`, `not_applicable` and `passed`
 * are recorded facts about a run that was never held up, and `overridden` is a park somebody
 * already answered. Listing any of them would put a decision in front of a caller with nothing to
 * decide, and `parked` is read off the run's own status rather than from this list, so a settled
 * verdict has nothing to add to it.
 */
function isLiveInputGate(gate: RunInputGate): boolean {
  return gate.status === 'blocked'
}

/**
 * Build the run's decision list: whatever it is currently asking a human, plus the run status so a
 * caller can distinguish "parked, answer me" from "still working". Three point-reads at most (the
 * run, the live review for its block, the run's fork state) — no per-step or per-item fan-out.
 *
 * The run is RE-READ rather than taken from the `ScopedRun` the caller was gated with, because
 * every mutating route builds its response through here AFTER acting: a `proceed` that advanced the
 * run, or an `incorporate` that flipped it out of `blocked`, must not report the pre-action status.
 * A run that vanished between the gate and here (a concurrent delete) falls back to the gated
 * snapshot rather than 500-ing on an action that already succeeded.
 */
async function buildDecisionList<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  scoped: ScopedRun,
): Promise<PublicDecisionList> {
  const container = c.get('container')
  const decisions: PublicDecision[] = []
  const execution =
    (await container.executionRepository.get(workspaceId, scoped.execution.id)) ?? scoped.execution

  const requirements = container.requirements
  if (requirements) {
    const review = await requirements.service.getForBlock(workspaceId, scoped.blockId)
    if (review && isLiveReview(review)) decisions.push(toRequirementsDecision(review))
  }

  const fork = await container.executionService.getForkDecision(workspaceId, execution.id)
  if (fork && isLiveFork(fork)) decisions.push(toForkDecision(fork))

  // The judge state is read off the run already in hand — no extra repository round-trip, since
  // all judge state rides the run's steps (the whole reason it has no side table).
  const judgeStep =
    execution.steps[execution.currentStep]?.judge != null
      ? execution.steps[execution.currentStep]
      : [...execution.steps].reverse().find((s) => s.judge != null)
  if (judgeStep?.judge && isLiveJudge(judgeStep.judge)) {
    decisions.push(toJudgeDecision(judgeStep.agentKind, judgeStep.judge))
  }

  // The input gate parks BEFORE the first dispatch, so when it is live it is the only thing the
  // run is asking. Listed first for that reason: it is the earliest question, and the steps whose
  // decisions follow have not run.
  if (execution.inputGate && isLiveInputGate(execution.inputGate)) {
    decisions.unshift(toInputGateDecision(execution.inputGate))
  }

  return {
    runId: execution.id,
    taskId: scoped.blockId,
    status: execution.status,
    // `blocked` IS the parked state — the run is waiting on a human and will not move until one
    // of these decisions is answered. Read from the run itself rather than inferred from the
    // decisions, so a run parked on a surface this projection doesn't model yet (a plain approval
    // gate, a human-test window) still reports `parked: true` with an empty list rather than
    // silently claiming all is well.
    parked: execution.status === 'blocked',
    decisions,
  }
}

/** The error a gate rejected with, kept as DATA so each handler emits its own typed `c.json`. */
type GateFailure = { fail: { status: 401 | 403 | 404 | 503; code: string; message: string } }

/**
 * Emit a gate's rejection as the surface's standard error body.
 *
 * The `c.json` call stays INSIDE each handler's closure (rather than this returning a built
 * `Response`) so `buildHonoRoute` keeps type-checking every handler against its contract's declared
 * response union — a bare `Response` would erase that. This just removes the eight identical copies
 * of the body/status shuffle, which is where an inconsistent error envelope would eventually creep
 * in between two routes of the same surface.
 */
function failureBody(fail: GateFailure['fail']): { error: { code: string; message: string } } {
  return { error: { code: fail.code, message: fail.message } }
}

/**
 * Resolve the run + require the answering scope, then hand the handler a settled context — or the
 * failure to emit. Every mutating route shares exactly this preamble, and duplicating it eight
 * times is how two surfaces drift apart.
 *
 * The failure is returned as DATA rather than a built `Response` (mirroring `authorize`) because
 * `buildHonoRoute` types each handler against its contract's declared response union: a bare
 * `Response` would erase that and stop the compiler checking the success payload.
 */
async function gateDecisionAction<E extends AppEnv>(
  c: Context<E>,
  runId: string,
): Promise<{ workspaceId: string; scoped: ScopedRun } | GateFailure> {
  // `decide` — the same rung that admits a parking pipeline in the first place. Answering injects
  // caller-supplied prose into the requirements every downstream agent then implements, so it sits
  // above ordinary `write` task authoring.
  const gate = await authorize(c, 'decide')
  if ('fail' in gate) return gate
  const { workspaceId } = gate.auth
  const scoped = await loadScopedRun(c, workspaceId, runId)
  if (!scoped) {
    return { fail: { status: 404, code: 'not_found', message: 'Run not found' } }
  }
  return { workspaceId, scoped }
}

/** The settled context a requirements route acts on. */
interface RequirementsAction {
  workspaceId: string
  scoped: ScopedRun
  requirements: RequirementsModule
  review: RequirementReview
}

/**
 * Gate a requirements action: the shared {@link gateDecisionAction} preamble, plus the opt-in
 * requirements module and the run's LIVE review. Every requirements route needs exactly this
 * quartet (key + scope, run, module, review), and hand-rolling it per route is how two surfaces
 * end up disagreeing about which review a run's answer applies to.
 */
async function gateRequirementsAction<E extends AppEnv>(
  c: Context<E>,
  runId: string,
): Promise<RequirementsAction | GateFailure> {
  const gated = await gateDecisionAction(c, runId)
  if ('fail' in gated) return gated
  const requirements = c.get('container').requirements
  if (!requirements) {
    return {
      fail: {
        status: 503,
        code: 'unavailable',
        message: 'Requirements review is not configured',
      },
    }
  }
  const { workspaceId, scoped } = gated
  const review = await requirements.service.getForBlock(workspaceId, scoped.blockId)
  if (!review) {
    return {
      fail: { status: 404, code: 'no_review', message: 'This run has no requirements review' },
    }
  }
  return { workspaceId, scoped, requirements, review }
}

export function publicDecisionController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  registerDecisionReadRoutes(app)
  registerRequirementsDecisionRoutes(app)
  registerForkDecisionRoutes(app)
  registerJudgeRoutes(app)
  registerInputGateRoutes(app)
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

function registerRequirementsDecisionRoutes(app: Hono<AppEnv>): void {
  // --- Requirements review: answer the findings, then drive the loop ----------
  // Each route is the external twin of a `RequirementReviewController` route, calling the same
  // service method. The item-level routes are addressed by ITEM id (not review id): a headless
  // caller reads the findings from `GET .../decisions`, and making it also thread a review id
  // through would be ceremony over a value it never chose. The live review is resolved from the
  // run's block, exactly as the SPA's block-scoped routes do.

  // Answer one finding.
  buildHonoRoute(app, replyPublicRunFindingContract, async (c) => {
    const { runId, itemId } = c.req.valid('param')
    const gated = await gateRequirementsAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped, requirements, review } = gated
    await requirements.service.replyToItem(
      workspaceId,
      review.id,
      itemId,
      c.req.valid('json').reply,
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Dismiss a finding as not applicable, or reopen one dismissed by mistake.
  buildHonoRoute(app, setPublicRunFindingStatusContract, async (c) => {
    const { runId, itemId } = c.req.valid('param')
    const gated = await gateRequirementsAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped, requirements, review } = gated
    await requirements.service.setItemStatus(
      workspaceId,
      review.id,
      itemId,
      c.req.valid('json').status,
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Fold the recorded answers into the standardized document. ASYNCHRONOUS: it records the intent
  // on the parked step and signals the durable driver, which folds + re-reviews in the background —
  // so the returned list shows the review `incorporating`, and the caller learns the outcome from
  // the SSE stream or a follow-up read, exactly as the SPA does.
  buildHonoRoute(app, incorporatePublicRunRequirementsContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateRequirementsAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.requirementsReview.incorporate(
        workspaceId,
        scoped.blockId,
        c.req.valid('json').feedback,
      )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // One more reviewer pass over the incorporated document. On convergence the parked run advances.
  buildHonoRoute(app, reReviewPublicRunRequirementsContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateRequirementsAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.requirementsReview.reReview(workspaceId, scoped.blockId)
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Settle the requirements phase and advance the parked run.
  buildHonoRoute(app, proceedPublicRunRequirementsContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateRequirementsAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.requirementsReview.proceed(workspaceId, scoped.blockId)
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Resolve a review that hit its iteration cap (extra round / proceed / stop and reset).
  buildHonoRoute(app, resolvePublicRunRequirementsExceededContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateRequirementsAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.requirementsReview.resolveExceeded(
        workspaceId,
        scoped.blockId,
        c.req.valid('json').choice,
      )
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
