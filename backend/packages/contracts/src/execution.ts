import * as v from 'valibot'
import { testConcernSchema, testReportSchema, testerInfraSetupSchema } from './testing.js'
import { consensusStepConfigSchema, stepGatingSchema } from './consensus.js'
import { followUpsStepStateSchema } from './followUp.js'
import { forkDecisionStepStateSchema } from './forkDecision.js'
import { ralphStepStateSchema } from './ralph.js'
import { prReviewStepStateSchema } from './prReview.js'
import { fragmentAdherenceSchema } from './fragment-adherence.js'
import { agentEffortReportSchema } from './agent-effort.js'
import { releaseSignalSchema } from './release.js'
import {
  environmentStatusSchema,
  infraEngineSchema,
  provisionTypeSchema,
  serviceProvisioningSchema,
} from './environments.js'
import { resolvedFrontendBindingSchema } from './frontend.js'
import { agentKindSchema, agentStateSchema } from './primitives.js'
import { stepOptionsSchema } from './entities.js'

// ---------------------------------------------------------------------------
// Run / execution runtime state: the shapes that describe an in-flight run and
// its steps' live state — human decisions, subtasks, review comments, companion
// verdicts, approvals, agent-run failures, the gate / tester / human-test /
// visual-confirm step-state machines, per-step metrics, the pipeline STEP (the
// runtime instance of a pipeline's step), and the execution instance itself.
// Split out of entities.ts (which keeps the board / pipeline-definition / model
// / workspace shapes); re-exported from the package barrel, so consumers are
// unaffected. Depends on entities.ts (for stepOptionsSchema); entities.ts does
// NOT depend back on this file.
// ---------------------------------------------------------------------------

export const decisionSchema = v.object({
  id: v.string(),
  question: v.string(),
  options: v.array(v.string()),
  chosen: v.nullable(v.string()),
})
export type Decision = v.InferOutput<typeof decisionSchema>

/** One entry of a running step's todo list — its label and current status. */
export const stepSubtaskItemSchema = v.object({
  /** The task's human-readable subject, as the agent wrote it. */
  label: v.string(),
  status: v.picklist(['pending', 'in_progress', 'completed']),
})
export type StepSubtaskItem = v.InferOutput<typeof stepSubtaskItemSchema>

/**
 * Live subtask counts for a running step, reported by the container agent from
 * the coding tool's own todo list (e.g. "3/8 done, 1 in progress"). Present only
 * while an async job is in flight and the agent maintains a todo list; the board
 * renders it as a finer-grained progress indicator than `progress` alone.
 *
 * `items` carries the individual todo entries (label + status) so a zoomed-in
 * card can render the actual task list, not just the count. It is optional — an
 * older agent/poll that only reported counts, or the simpler `todos[].done`
 * fallback shape, still validates without it.
 */
export const stepSubtasksSchema = v.object({
  completed: v.number(),
  inProgress: v.number(),
  total: v.number(),
  items: v.optional(v.array(stepSubtaskItemSchema)),
})
export type StepSubtasks = v.InferOutput<typeof stepSubtasksSchema>

/**
 * One GitHub-review-style comment left on a specific block or item of an agent's
 * proposal — either by a human reviewing an approval gate, or by a quality
 * companion (e.g. the Spec Reviewer) grading a structured output. `quotedSource`
 * is the verbatim raw markdown of the block the comment targets (sliced from the
 * proposal by its source line range), so a "request changes" re-run can quote the
 * agent's own text back to it rather than a re-rendered approximation. It is
 * OPTIONAL because a comment may instead anchor to a structured item via
 * {@link anchorId} (e.g. a spec requirement / acceptance-criterion id), where the
 * reviewed output is rendered as discrete items rather than free prose and there is
 * no quoted source range — the shape a companion returns.
 */
export const stepReviewCommentSchema = v.object({
  /**
   * Verbatim raw-markdown source of the commented prose block. Optional: a comment
   * may instead anchor to a structured item via {@link anchorId}, where there is no
   * prose source to quote.
   */
  quotedSource: v.optional(v.string()),
  /**
   * 0-based source line range [start, end) of the commented prose block, for
   * best-effort re-anchoring. Optional: a comment may instead anchor to a structured
   * item via {@link anchorId} (e.g. a spec requirement/acceptance-criterion id), where
   * there is no prose line range.
   */
  srcStart: v.optional(v.number()),
  srcEnd: v.optional(v.number()),
  /**
   * Stable id of the structured item the comment targets (e.g. a spec
   * requirement/criterion id), when the reviewed output is rendered as structured
   * items rather than free prose. Absent for prose-range comments.
   */
  anchorId: v.optional(v.string()),
  /** The reviewer's note on this block / item. */
  body: v.string(),
})
export type StepReviewComment = v.InferOutput<typeof stepReviewCommentSchema>

/**
 * The standardized, stored verdict a quality companion produced for an output it
 * graded — shared by every companion site (the pipeline companion step and the
 * requirements-rework gate). The raw model response is {@link companionAssessmentSchema}
 * (rating + summary + comments); this is the persisted, self-describing record of how
 * that assessment was applied: the `rating`, the `threshold` it was judged against,
 * whether it `passed`, and the `feedback` surfaced to the human / fed into a rework.
 */
export const companionVerdictSchema = v.object({
  /** Overall quality of the graded output (0..1, higher = better). */
  rating: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** The quality bar the rating had to reach to pass. */
  threshold: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** Whether the rating met the threshold. */
  passed: v.boolean(),
  /** The companion's challenge / justification (its assessment summary). */
  feedback: v.string(),
})
export type CompanionVerdict = v.InferOutput<typeof companionVerdictSchema>

/**
 * A human approval gate raised after a step whose pipeline marked it
 * `requiresApproval`. Unlike a {@link Decision} (which an agent raises and which
 * re-runs the same step on resolution), an approval gate fires once the step has
 * already produced its `proposal`; approving advances the run (carrying the —
 * possibly edited — proposal forward as context), requesting changes re-runs the
 * same step with the human's `feedback` (+ per-block `comments`), and rejecting
 * stops the run entirely (a terminal `rejected` failure the board can retry).
 */
export const stepApprovalSchema = v.object({
  /** Unique id of this gate; the durable run parks on it like a decision. */
  id: v.string(),
  /** `pending` while awaiting the human; terminal `approved`/`rejected`; `changes_requested` re-runs the step. */
  status: v.picklist(['pending', 'approved', 'changes_requested', 'rejected']),
  /** The agent's output the human is reviewing (editable before approval). */
  proposal: v.string(),
  /** When changes were requested, the human's freeform guidance fed into the re-run. */
  feedback: v.optional(v.string()),
  /** When changes were requested, per-block review comments fed into the re-run. */
  comments: v.optional(v.array(stepReviewCommentSchema)),
})
export type StepApproval = v.InferOutput<typeof stepApprovalSchema>

/**
 * The agent flows that produce an "agent run" (a container-backed job whose
 * lifecycle, progress and failure the board surfaces uniformly):
 *   - `bootstrap`  — a "bootstrap repo" run that scaffolds/adapts a new repo.
 *   - `execution`  — a task pipeline run that implements a board task.
 *   - `env-config-repair` — a coding agent that repairs an environment-provider
 *     config file in an existing repo (no board block; surfaced on the infra window).
 */
export const agentRunKindSchema = v.picklist(['bootstrap', 'execution', 'env-config-repair'])
export type AgentRunKind = v.InferOutput<typeof agentRunKindSchema>

/**
 * How an agent run faulted, so the board can classify the failure (and hint
 * whether a retry is likely to help). The union spans both flows; a given flow
 * only ever produces a subset:
 *   - `preflight`        — rejected before dispatch (repo missing/not empty, not connected). [bootstrap]
 *   - `dispatch`         — the container accept-request itself failed (HTTP / network). [bootstrap]
 *   - `evicted`          — the container vanished mid-run (eviction/crash). Retrying spins a fresh one.
 *   - `timeout`          — a container watchdog fired (inactivity or max-duration).
 *   - `agent`            — the agent / git push reported a failure.
 *   - `job_failed`       — an async container job came back failed. [execution]
 *   - `rejected`         — a human rejected a gated proposal, stopping the run. [execution]
 *   - `cancelled`        — the user (or an orphan sweep) explicitly stopped the run.
 *   - `unknown`          — anything not otherwise classified.
 */
export const agentFailureKindSchema = v.picklist([
  'preflight',
  'dispatch',
  // A `deployer` step's ephemeral-environment provisioning failed (the EnvironmentProvider
  // threw or returned `status:'failed'`) — distinct from `dispatch` (a container/runner
  // never accepting the job). The provider's verbatim error rides the failure `detail`.
  'environment',
  'evicted',
  'timeout',
  'agent',
  'job_failed',
  'rejected',
  // A companion agent could not return a parseable quality assessment (truncated /
  // malformed) even after a repair retry, so the run was failed for human attention.
  // (Exhausting the automatic rework budget no longer fails the run — it parks on the
  // companion iteration-cap gate for a human; see `companion.exceeded`.)
  'companion_rejected',
  // The run was still `running` in storage but its durable driver was gone (a crashed /
  // restarted orchestrator left the advance job orphaned), and the stale-run sweeper could
  // not recover it within the hard-stall deadline — so it is failed for human attention
  // instead of spinning `running` forever with no progress. Retry spins a fresh run.
  'stalled',
  'cancelled',
  'unknown',
])
export type AgentFailureKind = v.InferOutput<typeof agentFailureKindSchema>

/**
 * Structured diagnostics captured when an agent run fails, stored on the run and
 * surfaced on the board so a crash isn't just a one-line message. The container's
 * stdout/stderr can't always be pulled into this record (an evicted container is
 * gone), so for `evicted`/`timeout` failures the `hint` points at where to look.
 */
export const agentFailureSchema = v.object({
  kind: agentFailureKindSchema,
  /** Human-readable summary (mirrors the run's `error` for back-compat). */
  message: v.string(),
  /** Extended detail when available (the harness's reason, an HTTP body, …). */
  detail: v.nullable(v.string()),
  /** Where to look next (e.g. "check the container logs for this job id"). */
  hint: v.nullable(v.string()),
  /**
   * Optional machine-readable cause code so the SPA can render precise, actionable guidance
   * without string-matching the prose `message`/`detail` (the failure analogue of a
   * {@link ConflictReason}). Kind-scoped: an `environment` failure carries an
   * {@link EnvironmentFailureReason} (e.g. `deploy_runner_unwired`). Absent when the cause has
   * no client-specific handling.
   */
  reason: v.optional(v.nullable(v.string())),
  /** Epoch ms the failure was recorded. */
  occurredAt: v.number(),
  /** Last subtask counts seen before the failure, for context (null if none). */
  lastSubtasks: v.nullable(stepSubtasksSchema),
  /**
   * Index of the pipeline step that was in flight when the run failed (the run's
   * `currentStep` at fail time), so the per-attempt failure trail can be attributed to a
   * specific step — the step-detail overlay filters its "execution history" to the failures
   * recorded for that step. Absent on a bootstrap failure (no steps) and on legacy records.
   */
  stepIndex: v.optional(v.number()),
})
export type AgentFailure = v.InferOutput<typeof agentFailureSchema>

/**
 * A SUCCESSFUL step attempt whose output a restart later superseded — the positive
 * complement of {@link agentFailureSchema}. When a run is restarted from a step, that
 * step and every later one are reset and their `output` dropped; the ones that had
 * already succeeded are recorded here so the step-detail overlay's "execution history"
 * surfaces what a superseded attempt PRODUCED, not only the errors. Attributed to a
 * `stepIndex` exactly like a failure, and rides in the run's `detail` JSON (no column).
 */
export const priorStepOutputSchema = v.object({
  /** Index of the pipeline step that produced this output (see {@link agentFailureSchema} `stepIndex`). */
  stepIndex: v.number(),
  /** Epoch ms the superseded attempt finished (its `finishedAt`, else when it was recorded). */
  occurredAt: v.number(),
  /** The attempt's prose/JSON output, clipped to a stored-size bound when {@link truncated}. */
  output: v.string(),
  /** Whether {@link output} was clipped because the original exceeded the per-entry size bound. */
  truncated: v.optional(v.boolean()),
})
export type PriorStepOutput = v.InferOutput<typeof priorStepOutputSchema>

/**
 * State a polling **gate** step carries (today `ci` and `conflicts`). A gate is
 * special (like a `deployer` step): it is NOT itself an LLM/container agent. It
 * runs a programmatic precheck against a provider (CI check runs / PR mergeability)
 * for the PR head commit and only escalates to a helper container agent (`ci-fixer`
 * / `conflict-resolver`) on a negative verdict, looping until the precheck passes or
 * the attempt budget is spent. Which gate a step is comes from its `agentKind`, so it
 * is not duplicated here. See the engine's `GateDefinition` registry.
 *   - `phase: 'checking'` — running the precheck / waiting for the provider.
 *   - `phase: 'working'`  — a helper agent is in flight (tracked via the step's
 *                           `jobId`); on completion the gate returns to `checking`.
 */
/** One failing check the CI gate's precheck saw, flattened for display. */
export const gateFailingCheckSchema = v.object({
  name: v.string(),
  /** GitHub conclusion (e.g. `failure`, `timed_out`), or null when not reported. */
  conclusion: v.nullable(v.string()),
  /**
   * The check run's GitHub web URL (`html_url`), so the UI can link straight to the
   * failed run's logs. Null when GitHub didn't report one.
   */
  url: v.optional(v.nullable(v.string())),
  /**
   * The repo (owner/name) this check belongs to, on a MULTI-REPO block — so the UI can group
   * failing checks by service. Absent on a single-repo block (there is only the own repo).
   */
  repo: v.optional(v.string()),
})
export type GateFailingCheck = v.InferOutput<typeof gateFailingCheckSchema>

/**
 * One helper-agent attempt the gate dispatched (a ci-fixer / conflict-resolver run),
 * recorded when the job finishes so the UI can show what each attempt tried and how it
 * ended — detail that used to be discarded the moment the gate re-probed.
 */
export const gateAttemptSchema = v.object({
  /** 1-based attempt number (matches `attempts` at the time the helper was dispatched). */
  attempt: v.number(),
  /** Epoch ms when the helper job finished. */
  at: v.number(),
  /**
   * How the helper job ended:
   *   - `completed` — the container finished (it may or may not have fully fixed the
   *     issue; the gate's next precheck is the source of truth, and `summary` carries
   *     the agent's own account, e.g. which files it left conflicting).
   *   - `failed`    — the job errored / was evicted without finishing.
   */
  outcome: v.picklist(['completed', 'failed']),
  /** The PR head commit the helper worked against, when known. */
  headSha: v.optional(v.nullable(v.string())),
  /**
   * The fixing instructions handed to the helper for this round — the failing-check
   * summary the CI gate fed the `ci-fixer`, the conflict reason / human-review comments
   * the other gates fed their fixer. Stashed at dispatch and recorded with the attempt so
   * the run-detail UI can show WHAT each round was asked to fix (not only that a round
   * happened) — the gate analogue of the Tester attempt's `concerns`. Null when the gate
   * hands its fixer no textual instructions (the conflicts gate: GitHub reports mergeability
   * as a single bit and the harness leaves the conflict markers for the resolver).
   */
  instructions: v.optional(v.nullable(v.string())),
  /**
   * Structured failing checks handed to this attempt's helper (the CI gate's red check runs
   * behind {@link instructions}), snapshotted at dispatch so each attempt shows the checks it
   * set out to fix. Absent for the conflicts gate (no file-level detail) and when the round
   * carried no structured checks.
   */
  failingChecks: v.optional(v.nullable(v.array(gateFailingCheckSchema))),
  /** The helper's own summary (or the failure reason), naming what it did / what remains. */
  summary: v.optional(v.nullable(v.string())),
})
export type GateAttempt = v.InferOutput<typeof gateAttemptSchema>

export const gateStepStateSchema = v.object({
  phase: v.picklist(['checking', 'working']),
  /** How many helper-agent attempts have been dispatched so far. */
  attempts: v.number(),
  /** Ceiling on attempts, resolved from the task's merge preset at step start. */
  maxAttempts: v.number(),
  /** The PR head commit being gated, once resolved (the own-service PR on a multi-repo block). */
  headSha: v.optional(v.nullable(v.string())),
  /**
   * Per-PR head commits for a MULTI-REPO block (service-connections phase 4), keyed by repo
   * full name (owner/name) — own-service PR plus each peer-service PR. Set by the CI /
   * conflicts gates whose precheck aggregates across every PR the task opened. Absent for a
   * single-repo block (the scalar {@link headSha} is the only head).
   */
  headShas: v.optional(v.nullable(v.record(v.string(), v.string()))),
  /**
   * The repo the conflicts gate's most recent `fail` verdict found conflicted, so the
   * single-repo conflict-resolver is dispatched at THAT repo (own-service or a peer) rather
   * than always the own-service one. Absent ⇒ the own-service repo. Only the conflicts gate
   * sets it (the CI-fixer runs across all repos, so the CI gate leaves it undefined).
   */
  conflictTarget: v.optional(
    v.nullable(
      v.object({
        repo: v.string(),
        frameId: v.optional(v.string()),
        branch: v.optional(v.string()),
      }),
    ),
  ),
  /**
   * The most recent precheck verdict, so the UI can show why the gate is looping
   * (failing → a helper is fixing) vs idle-passing. Set on every probe.
   */
  lastVerdict: v.optional(v.nullable(v.picklist(['pass', 'pending', 'fail']))),
  /**
   * Human-readable summary of the latest failing precheck (the failing CI checks /
   * the conflict reason) — the conclusion detail that used to be fed only to the
   * helper agent and then discarded. Carried across the helper dispatch so the
   * window keeps showing what is being fixed. Null when the last probe passed.
   */
  lastFailureSummary: v.optional(v.nullable(v.string())),
  /**
   * Structured failing checks behind {@link lastFailureSummary} for the CI gate, so
   * the UI can list each red check by name + conclusion. Absent for the conflicts
   * gate (GitHub reports no file-level detail) and when the last probe passed.
   */
  failingChecks: v.optional(v.nullable(v.array(gateFailingCheckSchema))),
  /**
   * The fixing instructions handed to the most-recently dispatched helper (the failing-check
   * summary / conflict reason / human fix prompt), stashed at dispatch so the attempt recorded
   * when that helper's job settles can carry WHAT the round was asked to fix onto its
   * {@link gateAttemptSchema} entry. Transient bookkeeping — the durable per-round history lives
   * on {@link attemptLog}. Null when the gate hands its fixer no textual instructions.
   */
  lastDispatchedInstructions: v.optional(v.nullable(v.string())),
  /**
   * Epoch ms of the release marker for a time-windowed gate (post-release-health) — the
   * moment it began watching the deployed release. The gate keeps polling `pending`
   * until this + the preset's watch window has elapsed (then a clean run passes) or a
   * monitor/SLO regresses (then it escalates to the on-call agent). Absent for the
   * CI/conflicts gates.
   */
  watchSince: v.optional(v.nullable(v.number())),
  /**
   * The watch-window length (minutes) for a time-windowed gate (post-release-health),
   * resolved from the task's merge preset ONCE on first entry (alongside `maxAttempts`)
   * so the probe doesn't re-load the block + re-resolve the preset on every poll. Absent
   * for the CI/conflicts gates.
   */
  watchWindowMinutes: v.optional(v.nullable(v.number())),
  /**
   * The regressed signals captured when the post-release-health gate escalated to the
   * on-call agent, so the agent's completion handler can build the `release_regression`
   * notification + incident enrichment from the SAME evidence the agent investigated
   * — rather than re-reading Datadog (a third round-trip that could also disagree with
   * what the agent saw if the window moved). Absent for the CI/conflicts gates.
   */
  regressedSignals: v.optional(v.nullable(v.array(releaseSignalSchema))),
  /**
   * Append-only history of the helper-agent attempts this gate dispatched (ci-fixer /
   * conflict-resolver runs), each recorded when its job finished. Lets the UI show what
   * every attempt tried and how it ended, instead of only a bare `attempts` count.
   * Absent for the post-release-health gate (its on-call helper is resolved specially).
   */
  attemptLog: v.optional(v.nullable(v.array(gateAttemptSchema))),
  // ---- human-review gate only (absent for the CI/conflicts/post-release-health gates) ----
  /**
   * The number of approving reviews the PR had at the last probe, so the UI can show
   * "1 / N approvals". The "required" side is derived from {@link requiredApprovingReviewCount}
   * via the same `max(1, …)` floor the gate applies (see review.logic.ts) rather than persisted
   * a second time. Absent for the other gates.
   */
  lastApprovals: v.optional(v.nullable(v.number())),
  /**
   * The raw branch-protection required-approving-review count, cached after the FIRST probe
   * resolves it so subsequent polls skip the static protection read (branch protection is repo
   * config, not PR activity — re-reading it every poll over a multi-day review only burns GitHub
   * rate budget). The UI's displayed "required" count is `max(1, this)` (the gate's effective
   * floor). Absent for the other gates.
   */
  requiredApprovingReviewCount: v.optional(v.nullable(v.number())),
  /**
   * The GraphQL ids of the review threads the gate just handed the `fixer`, stashed at
   * dispatch so the helper-completion hook can post a reply + RESOLVE exactly those threads
   * on GitHub before the next probe reads them. Absent for the other gates.
   */
  pendingThreadIds: v.optional(v.nullable(v.array(v.string()))),
  /**
   * Epoch ms of the newest plain PR comment the gate has already handed the `fixer`. Plain
   * conversation comments (unlike review threads) can't be "resolved" on GitHub, so they are
   * tracked by timestamp: a comment newer than this is outstanding; the dispatch advances it to
   * the batch max. A reviewer's later comment (newer timestamp) re-opens the work. Absent for
   * the other gates.
   */
  lastAddressedCommentAt: v.optional(v.nullable(v.number())),
  /**
   * The grace window (minutes) the human-review gate waits after the latest review comment
   * before dispatching the fixer, resolved from the task's merge preset ONCE on first entry
   * (alongside `maxAttempts`) so the probe doesn't re-resolve the preset every poll. Absent
   * for the other gates.
   */
  humanReviewGraceMinutes: v.optional(v.nullable(v.number())),
  /**
   * A human-initiated freeform fix request parked on the gate (an in-app prompt). Consumed at
   * the top of the next `evaluateGate` pass, which dispatches the fixer with these instructions
   * folded in — bypassing the grace window. Absent for the other gates.
   */
  pendingFix: v.optional(
    v.nullable(
      v.object({
        instructions: v.string(),
        at: v.number(),
      }),
    ),
  ),
})
export type GateStepState = v.InferOutput<typeof gateStepStateSchema>

/**
 * State a `tester` step carries while it runs the Tester → Fixer loop. Unlike `ci`,
 * the gate's own work IS a container job (the Tester); on a withheld greenlight the
 * engine loops a `fixer` container agent and re-tests.
 *   - `phase: 'testing'` — a Tester job is in flight (tracked via the step's `jobId`).
 *   - `phase: 'fixing'`  — a Fixer job is in flight; on completion the step returns to
 *                          `testing` and a fresh Tester job is dispatched.
 */
/**
 * One round of the Tester→Fixer loop, recorded when a `fixer` job finishes so the test
 * window can show what each fixer attempt set out to fix and how it ended — the analogue of
 * a polling gate's {@link gateAttemptSchema}, since a fixer run is otherwise an opaque
 * sub-job with no surface of its own (only a bare `attempts` count).
 */
export const testerAttemptSchema = v.object({
  /** 1-based fixer round (matches `attempts` after the fixer for this round was dispatched). */
  attempt: v.number(),
  /** Epoch ms when the fixer job finished. */
  at: v.number(),
  /** Whether the fixer container finished (`completed`) or errored/was evicted (`failed`). */
  outcome: v.picklist(['completed', 'failed']),
  /** The fixer's own summary (or the failure reason), naming what it changed / what failed. */
  summary: v.optional(v.nullable(v.string())),
  /**
   * The concerns the fixer was handed for this round (from the Tester report that withheld
   * its greenlight), so the window can show WHAT each round tried to address — not only that
   * a round happened.
   */
  concerns: v.optional(v.nullable(v.array(testConcernSchema))),
})
export type TesterAttempt = v.InferOutput<typeof testerAttemptSchema>

export const testerStepStateSchema = v.object({
  phase: v.picklist(['testing', 'fixing']),
  /** How many `fixer` attempts have been dispatched so far. */
  attempts: v.number(),
  /** Ceiling on fixer attempts, resolved from the task's merge preset at step start. */
  maxAttempts: v.number(),
  /** The most recent Tester report (what was tested, outcomes, concerns, greenlight). */
  lastReport: v.optional(v.nullable(testReportSchema)),
  /**
   * Append-only history of the `fixer` rounds this Tester step looped through, each recorded
   * when its job finished. Lets the test window surface an inspectable timeline of the fixer
   * attempts (what each addressed, how it ended) instead of only a bare `attempts` count.
   */
  attemptLog: v.optional(v.nullable(v.array(testerAttemptSchema))),
  /**
   * The most recent in-container docker-compose dependency stand-up record (local-infra
   * tester): whether the dependencies came up and the captured (redacted, bounded)
   * `docker compose up` logs. Refreshed on each Tester round (it stands the infra up anew),
   * so the test window can surface WHY local infra failed to come up — the failure-class
   * artifact the orchestrator-side provisioning logs can't see. Absent for ephemeral /
   * no-infra runs. See {@link testerInfraSetupSchema}.
   */
  infraSetup: v.optional(v.nullable(testerInfraSetupSchema)),
})
export type TesterStepState = v.InferOutput<typeof testerStepStateSchema>

/**
 * One test quality-control companion verdict, recorded per QC evaluation of a Tester
 * report (in order; newest last). `adequate` is the QC's judgement that the report is
 * complete enough to conclude testing / go to the fixer; when false, `gaps` lists the
 * concrete things the Tester still needs to exercise and `feedback` is the prose the
 * Tester is handed on its re-run.
 */
export const testerQualityVerdictSchema = v.object({
  /** Whether the report is complete/coherent enough to proceed (no QC re-run needed). */
  adequate: v.boolean(),
  /** The QC's prose challenge / justification, folded into the Tester's re-run context. */
  feedback: v.string(),
  /** Concrete coverage gaps the Tester must still address (empty when adequate). */
  gaps: v.array(v.string()),
  /** Epoch ms the verdict was produced. */
  at: v.number(),
  /** The model that produced the verdict, for transparency. */
  model: v.optional(v.nullable(v.string())),
})
export type TesterQualityVerdict = v.InferOutput<typeof testerQualityVerdictSchema>

/**
 * Live test quality-control loop state carried on a run's Tester step, copied from the
 * pipeline's per-step `testerQualityConfigSchema` (see entities.ts) at run start. The QC companion reads
 * each Tester report BEFORE the greenlight/fixer decision; when the report is inadequate and
 * `attempts < maxAttempts` it loops the Tester (folding the prior report + `feedback` in),
 * bounded independently of the fixer budget. `verdicts` records each evaluation for the UI.
 */
export const testerQualityStepStateSchema = v.object({
  /** Whether the QC companion is active on this Tester step (the builder toggle). */
  enabled: v.boolean(),
  /** How many QC-driven Tester re-runs have been dispatched so far. */
  attempts: v.optional(v.number(), 0),
  /** Ceiling on QC-driven re-runs, from the task's merge preset (`maxTesterQualityIterations`). */
  maxAttempts: v.number(),
  /** Optional estimate gating copied from the pipeline; evaluated against the block estimate. */
  gating: v.optional(v.nullable(stepGatingSchema)),
  /** One verdict per QC evaluation, in order (newest last). Empty before the first grade. */
  verdicts: v.array(testerQualityVerdictSchema),
  /** Set true once the QC budget was spent with the report still judged inadequate. */
  exceeded: v.optional(v.boolean()),
})
export type TesterQualityStepState = v.InferOutput<typeof testerQualityStepStateSchema>

/**
 * The compact ephemeral-environment view a `human-test` gate carries on its step, so the
 * dedicated window can surface the live URL/status without a second fetch. The full record
 * (with encrypted access creds) lives in the `environments` table; this is the non-secret
 * projection. Null in degraded manual mode (no env provider wired) or after the human
 * destroys the env from the gate.
 */
/**
 * The compact, non-secret projection of the ephemeral environment a run's step is
 * associated with — its lifecycle state, public URL, TTL, and (when failed) the
 * exact provider error. Surfaced in a run's details (esp. the Tester step) so the
 * env's spinning-up / running / shut-down / errored state is visible without a
 * second fetch. The full record (with encrypted creds) lives in the `environments`
 * table. {@link humanTestEnvironmentSchema} is the human-test gate's subset of this.
 */
export const runEnvironmentSchema = v.object({
  /** The `environments` row id (lets a window fetch access creds / re-poll status). */
  id: v.string(),
  /** The provisioned public URL (null while still provisioning). */
  url: v.nullable(v.string()),
  /** The environment lifecycle status; see {@link environmentStatusSchema}. */
  status: environmentStatusSchema,
  /** Epoch ms the environment expires (TTL), when known. */
  expiresAt: v.optional(v.nullable(v.number())),
  /** The verbatim provider error when the environment failed/expired, else null. */
  lastError: v.optional(v.nullable(v.string())),
  /**
   * The service's declared provision type this environment was stood up for
   * (`kubernetes` | `docker-compose` | `custom` | `infraless`), recorded at provision
   * time so a run's details show exactly what was provisioned. Null for legacy rows /
   * pre-resolution.
   */
  provisionType: v.optional(v.nullable(provisionTypeSchema)),
  /**
   * The resolved engine that handled the provisioning (`local-docker` | `local-k3s` |
   * `remote-kubernetes` | `remote-custom` | `none`), surfaced in run details alongside the
   * environment state. Null for legacy rows / pre-resolution.
   */
  engine: v.optional(v.nullable(infraEngineSchema)),
})
export type RunEnvironment = v.InferOutput<typeof runEnvironmentSchema>

/**
 * The lifecycle status of the per-run container backing a container agent step:
 * `starting` (dispatching / cold-booting), `up` (running the agent's job),
 * `errored` (the container failed to start, was evicted, or its job faulted), and
 * `destroyed` (the run's container has been reclaimed). The SPA additionally derives
 * `destroyed` for a finished run's container steps (the container is reclaimed as a
 * unit when the run terminates), so the backend only ever persists the first three.
 */
export const runContainerStatusSchema = v.picklist(['starting', 'up', 'errored', 'destroyed'])
export type RunContainerStatus = v.InferOutput<typeof runContainerStatusSchema>

/**
 * The compact, non-secret projection of the per-run container a container agent step
 * runs in, so a run's details can show WHAT the container is doing and WHERE it lives
 * instead of a step's "spinning up container…" badge vanishing into a blank "working"
 * state once the container is up. Populated by the engine across the dispatch + poll
 * lifecycle of an async (container) step; only ever set on container-backed steps.
 */
export const runContainerSchema = v.object({
  /** The container lifecycle status; see {@link runContainerStatusSchema}. */
  status: runContainerStatusSchema,
  /**
   * The coarse phase the agent's job is in while the container is `up` (`clone` →
   * `agent` → `push`, seeded `starting`), forwarded from the harness. Lets the details
   * distinguish "still preparing the checkout" from "the agent is making calls". Absent
   * until the first poll, or when the runner doesn't report a phase.
   */
  phase: v.optional(v.nullable(v.string())),
  /** Provider container/runner id (Cloudflare DO id, docker container id), when known. */
  id: v.optional(v.nullable(v.string())),
  /** A reachable address for the running container (the local docker host URL), when one exists. */
  url: v.optional(v.nullable(v.string())),
})
export type RunContainer = v.InferOutput<typeof runContainerSchema>

/** The web-search backend a run's container searches through, when search is available. */
export const webSearchProviderSchema = v.picklist(['brave', 'searxng'])
export type WebSearchProvider = v.InferOutput<typeof webSearchProviderSchema>

/**
 * Narrow a free-text stored value (a telemetry `provider` column, which is plain TEXT) back
 * to the {@link WebSearchProvider} union, or null when it isn't one. The single source of
 * truth both telemetry stores use to map their rows, so the union is defined once.
 */
export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return value === 'brave' || value === 'searxng'
}

/**
 * Whether a container agent had web search available for its run, and — when it did —
 * which upstream backend served it (resolved backend-side at dispatch from the run's
 * account keys, else the deployment default). Surfaced on a container step so the run
 * details can say "Web search: SearXNG" vs "Web search: unavailable"; it is a static
 * dispatch-time fact, NOT gated by prompt-recording telemetry (the performed queries
 * are — see the agent-search-query observability sink). `provider` is null when search
 * was unavailable.
 */
export const webSearchAvailabilitySchema = v.object({
  available: v.boolean(),
  provider: v.nullable(webSearchProviderSchema),
})
export type WebSearchAvailability = v.InferOutput<typeof webSearchAvailabilitySchema>

/**
 * The TERMINAL per-frame outcome of one environment a `deployer` step provisioned during a
 * multi-env fan-out (the task's own service frame + every involved-service frame): `ready`
 * (a live env, `url` set), `failed` (the provision broke, `error` carries the cause), or
 * `skipped` (the frame is `infraless`, nothing stood up). The IN-FLIGHT frame is not recorded
 * here — it lives on `step.jobId`/`step.deployFrameId` until it settles. See
 * {@link pipelineStepSchema.entries.deployEnvs}.
 */
export const deployEnvStateSchema = v.object({
  status: v.picklist(['ready', 'failed', 'skipped']),
  /** The provisioned URL for a `ready` env (absent for `failed`/`skipped`). */
  url: v.optional(v.nullable(v.string())),
  /** The verbatim provider error for a `failed` env. */
  error: v.optional(v.nullable(v.string())),
})
export type DeployEnvState = v.InferOutput<typeof deployEnvStateSchema>

/** Per-frame deploy outcomes keyed by service-frame block id; see {@link deployEnvStateSchema}. */
export const deployEnvsSchema = v.record(v.string(), deployEnvStateSchema)
export type DeployEnvs = v.InferOutput<typeof deployEnvsSchema>

export const humanTestEnvironmentSchema = v.object({
  /** The `environments` row id, so the window can fetch access creds / re-poll status. */
  id: v.string(),
  /** The provisioned public URL the human tests against (null while still provisioning). */
  url: v.nullable(v.string()),
  /** The environment lifecycle status; see {@link environmentStatusSchema}. */
  status: environmentStatusSchema,
  /** Epoch ms the environment expires (TTL), when known. */
  expiresAt: v.optional(v.nullable(v.number())),
})
export type HumanTestEnvironment = v.InferOutput<typeof humanTestEnvironmentSchema>

/**
 * One round of human-driven remediation on a `human-test` gate: the human wrote findings and
 * asked for a fix (helper `fixer`), or pulled main and hit a conflict (helper
 * `conflict-resolver`). Appended when the round opens and stamped with its outcome once the
 * helper job settles, so the window can show the full history of what was asked and how it ended.
 */
export const humanTestRoundSchema = v.object({
  /** The kind of round — a findings-driven fix or a pull-main-with-conflicts resolve. */
  kind: v.picklist(['fix', 'pull-main']),
  /** The human's findings prompt (fix), or a one-line note for the pull-main round. */
  findings: v.string(),
  /** The helper container kind this round dispatched (`fixer` / `conflict-resolver`). */
  helperKind: v.string(),
  /** The helper job's id while it ran, for cross-referencing the run timeline. */
  jobId: v.optional(v.nullable(v.string())),
  /** How the helper ended once its job settled. Absent while still in flight. */
  outcome: v.optional(v.nullable(v.picklist(['completed', 'failed']))),
  /** Epoch ms the round opened (the human clicked Request fix / Pull main). */
  at: v.number(),
})
export type HumanTestRound = v.InferOutput<typeof humanTestRoundSchema>

/**
 * State a `human-test` gate carries while it runs. Unlike a polling gate (`ci`/`conflicts`)
 * there is no programmatic verdict — the HUMAN is the verdict — so the step spins up an
 * ephemeral environment, parks for a person to validate it, and on demand dispatches the same
 * helpers the other gates use (the Tester's `fixer` for findings; the `conflict-resolver` for a
 * conflicting pull-main). Phases:
 *   - `provisioning`        — an environment is being stood up (the driver polls until ready).
 *   - `awaiting_human`      — parked: the human tests the env and confirms / requests a fix / etc.
 *   - `fixing`              — a `fixer` job (from the human's findings) is in flight.
 *   - `resolving_conflicts` — a `conflict-resolver` job (from a conflicting pull-main) is in flight.
 *   - `passed`             — the human confirmed; the env is torn down and the run advances.
 */
export const humanTestStepStateSchema = v.object({
  phase: v.picklist(['provisioning', 'awaiting_human', 'fixing', 'resolving_conflicts', 'passed']),
  /** The live ephemeral environment (null in degraded manual mode / after destroy). */
  environment: v.optional(v.nullable(humanTestEnvironmentSchema)),
  /**
   * Why no environment was auto-provisioned — set in degraded manual mode (no env provider
   * wired, or provisioning errored) so the window can explain it and let the human test
   * against the PR branch manually. Absent when an env was provisioned.
   */
  degradedReason: v.optional(v.nullable(v.string())),
  /** How many helper (fixer / conflict-resolver) attempts have been dispatched so far. */
  attempts: v.number(),
  /** Ceiling on helper attempts, resolved from the task's merge preset (`ciMaxAttempts`). */
  maxAttempts: v.number(),
  /** The PR head commit being tested, when known. */
  headSha: v.optional(v.nullable(v.string())),
  /** Append-only history of fix / pull-main rounds; see {@link humanTestRoundSchema}. */
  rounds: v.optional(v.array(humanTestRoundSchema)),
  /**
   * Transient action the human requested while the gate is parked — recorded on the parked
   * step and consumed by the durable driver when it re-enters the gate (the analogue of
   * `pendingIncorporation` on a requirements gate). Cleared once the driver acts on it.
   */
  pendingAction: v.optional(
    v.nullable(
      v.object({
        type: v.picklist(['confirm', 'request-fix', 'pull-main', 'recreate']),
        /** The findings prompt for a `request-fix` action. */
        findings: v.optional(v.string()),
      }),
    ),
  ),
})
export type HumanTestStepState = v.InferOutput<typeof humanTestStepStateSchema>

/**
 * One actual-vs-reference pairing the visual-confirmation gate shows the human: a logical
 * view, the screenshot the UI tester captured of it (`actualArtifactId`), and the reference
 * design image for the same view when one was uploaded (`referenceArtifactId`). Either side
 * may be absent (a captured view with no reference, or a reference whose view wasn't captured).
 */
export const visualConfirmPairSchema = v.object({
  view: v.string(),
  actualArtifactId: v.optional(v.nullable(v.string())),
  referenceArtifactId: v.optional(v.nullable(v.string())),
})
export type VisualConfirmPair = v.InferOutput<typeof visualConfirmPairSchema>

/** One human-requested fix round on a visual-confirmation gate (dispatches the `fixer`). */
export const visualConfirmRoundSchema = v.object({
  findings: v.string(),
  helperKind: v.string(),
  jobId: v.optional(v.nullable(v.string())),
  outcome: v.optional(v.nullable(v.picklist(['completed', 'failed']))),
  at: v.number(),
})
export type VisualConfirmRound = v.InferOutput<typeof visualConfirmRoundSchema>

/**
 * State a `visual-confirmation` gate carries while it runs. Like `human-test` there is no
 * programmatic verdict — a HUMAN reviews the UI tester's screenshots against the uploaded
 * reference designs and approves, or requests a fix (which dispatches the `fixer` and then
 * re-captures via the UI tester). Phases:
 *   - `awaiting_human`— parked: the human reviews actual-vs-reference and approves / requests a fix.
 *   - `fixing`        — a `fixer` job (from the human's findings) is in flight.
 *   - `approved`      — the human approved; the run advances.
 *
 * (A dedicated `capturing` phase for an auto re-run of the UI tester after a fix is deferred
 * until that loop is wired — see the visual-confirmation handover doc — so it is intentionally
 * absent from the picklist rather than carried as dead state.)
 */
export const visualConfirmStepStateSchema = v.object({
  phase: v.picklist(['awaiting_human', 'fixing', 'approved']),
  /** The actual-vs-reference pairs the human reviews, refreshed on each (re)capture. */
  pairs: v.optional(v.array(visualConfirmPairSchema)),
  /** Set when no screenshots could be gathered (no UI tester ran / no storage) — manual mode. */
  degradedReason: v.optional(v.nullable(v.string())),
  /** How many fixer attempts have been dispatched so far. */
  attempts: v.number(),
  /** Ceiling on fixer attempts, resolved from the task's merge preset (`ciMaxAttempts`). */
  maxAttempts: v.number(),
  /** Append-only history of fix rounds; see {@link visualConfirmRoundSchema}. */
  rounds: v.optional(v.array(visualConfirmRoundSchema)),
  /**
   * Transient action the human requested while parked — consumed by the durable driver
   * when it re-enters the gate. Cleared once acted on.
   */
  pendingAction: v.optional(
    v.nullable(
      v.object({
        type: v.picklist(['approve', 'request-fix', 'recapture']),
        /** The findings prompt for a `request-fix` action. */
        findings: v.optional(v.string()),
      }),
    ),
  ),
})
export type VisualConfirmStepState = v.InferOutput<typeof visualConfirmStepStateSchema>

/**
 * Per-step LLM observability rollup: a compact aggregate over every model call the
 * step's container made, recorded by the LLM proxy and summed by the engine for the
 * board. It surfaces, at a glance, token usage, how close the step ran to its
 * output-token limit (truncation), the latency split between transport/proxy
 * overhead and actual model execution, and any errors/warnings. The full per-call
 * detail (prompts + responses) is fetched on demand for the drill-down panel.
 * Absent when the observability sink is not wired.
 */
export const stepMetricsSchema = v.object({
  /** Number of model calls recorded for this step. */
  calls: v.number(),
  /** Sum of prompt (input) tokens across the step's calls. */
  promptTokens: v.number(),
  /**
   * Sum of prompt tokens served from the provider's prefix cache. A subset of
   * promptTokens on OpenAI/DeepSeek, but on Anthropic cache reads are reported
   * separately from input tokens, so this can exceed promptTokens. 0 on a cache-less
   * flavour (Workers AI); the metrics bar shows the cached split when present. Absent ⇒
   * unknown (older snapshot).
   */
  cachedPromptTokens: v.optional(v.number()),
  /** Sum of completion (output) tokens across the step's calls. */
  completionTokens: v.number(),
  /** Largest single completion the model produced (closest approach to the limit). */
  peakCompletionTokens: v.number(),
  /** The output ceiling in effect (max requested `max_tokens`), or null when unknown. */
  maxOutputTokens: v.nullable(v.number()),
  /** Calls cut short by the output limit (`finish_reason === 'length'`). */
  truncatedCalls: v.number(),
  /** Sum of model execution time (ms) — the "actual prompt/tool execution" slice. */
  upstreamMs: v.number(),
  /** Sum of transport/proxy overhead (ms) — the interim-layer cost. */
  overheadMs: v.number(),
  /** Calls that failed (non-2xx / refused / in-process error). */
  errors: v.number(),
  /** Successful calls that warned (truncated or content-filtered). */
  warnings: v.number(),
})
export type StepMetrics = v.InferOutput<typeof stepMetricsSchema>

export const pipelineStepSchema = v.object({
  /**
   * Id of the execution run (the {@link executionInstanceSchema} `id`) this step
   * belongs to — surfaced on every step so a lone step in a log line or a detail view
   * can name its run, for easier debugging. A projection that always equals the parent
   * instance's `id`: stamped from the enclosing instance when the run is read or
   * emitted, not persisted independently. Absent only on steps not yet round-tripped.
   */
  runId: v.optional(v.string()),
  agentKind: agentKindSchema,
  state: agentStateSchema,
  progress: v.number(),
  /** LLM observability rollup for this step; see {@link stepMetricsSchema}. */
  metrics: v.optional(v.nullable(stepMetricsSchema)),
  /**
   * Live gate state while a polling gate step (`ci` / `conflicts`) runs its
   * precheck-or-escalate loop; see {@link gateStepStateSchema}. The gate kind is
   * `agentKind`.
   */
  gate: v.optional(v.nullable(gateStepStateSchema)),
  /** Live Tester→Fixer loop state while a `tester` step runs/fixes; see {@link testerStepStateSchema}. */
  test: v.optional(v.nullable(testerStepStateSchema)),
  /**
   * Live test quality-control companion state on a `tester-api`/`tester-ui` step, copied
   * from the pipeline's per-step `testerQuality` config at run start. Drives the QC loop that
   * gates each Tester report for completeness before the greenlight/fixer decision. Absent
   * for non-Tester steps / when the companion is disabled. See {@link testerQualityStepStateSchema}.
   */
  testerQuality: v.optional(v.nullable(testerQualityStepStateSchema)),
  /**
   * Live state of a `human-test` gate (ephemeral env + human validation loop); see
   * {@link humanTestStepStateSchema}. Absent for every other step kind.
   */
  humanTest: v.optional(v.nullable(humanTestStepStateSchema)),
  /**
   * Live state of a `visual-confirmation` gate (screenshot review + fix loop); see
   * {@link visualConfirmStepStateSchema}. Absent for every other step kind.
   */
  visualConfirm: v.optional(v.nullable(visualConfirmStepStateSchema)),
  /**
   * The ephemeral environment this step runs against (when the block has one), so a
   * run's details can show its spinning-up / running / shut-down / errored state +
   * the exact error. Populated by the engine for container/deployer steps from the
   * block's live environment; see {@link runEnvironmentSchema}. The `human-test` gate
   * keeps its own richer `humanTest.environment` and is not double-populated here.
   */
  environment: v.optional(v.nullable(runEnvironmentSchema)),
  /** Live subtask counts while an async (container) step runs; see {@link stepSubtasksSchema}. */
  subtasks: v.optional(stepSubtasksSchema),
  /**
   * The per-run container this async (container) step runs in — its lifecycle status
   * (starting / up / errored), the agent's current phase (clone / agent / push), and
   * the container's id + reachable URL once up. Lets a run's details surface what the
   * container is doing and where it lives, so the board shows an explicit "Spinning up
   * container…" → live-phase progression instead of a blank "working" state. Set the
   * moment the job is dispatched (the dispatch blocks until the container accepts the
   * job) and refined on each poll. Only ever set on async (container) steps; absent on
   * non-container steps and steps not yet dispatched. See {@link runContainerSchema}.
   */
  container: v.optional(v.nullable(runContainerSchema)),
  /**
   * Whether web search was available to this container step, and which upstream backend
   * served it. Set at dispatch (a static per-run fact resolved from the account's
   * web-search keys, else the deployment default). Only ever set on async (container)
   * steps; absent on non-container steps and steps not yet dispatched. Distinct from the
   * telemetry-gated per-query log — this is always surfaced. See {@link webSearchAvailabilitySchema}.
   */
  search: v.optional(v.nullable(webSearchAvailabilitySchema)),
  decision: v.nullable(decisionSchema),
  /**
   * Whether a human approval gate fires after this step completes. Copied from
   * the pipeline's `gates` at run start; absent means no gate.
   */
  requiresApproval: v.optional(v.boolean()),
  /**
   * The live approval gate for this step (see {@link stepApprovalSchema}). Set
   * once the step's proposal is ready and `requiresApproval` is true; null/absent
   * otherwise.
   */
  approval: v.optional(v.nullable(stepApprovalSchema)),
  /**
   * Live state of a companion step that reviews a preceding producer step. Set when
   * this step's `agentKind` is a companion kind. `threshold` is the quality bar the
   * companion's latest rating (the last `verdicts` entry) must reach; `attempts`
   * counts only the AUTOMATIC reworks performed, and once it reaches `maxAttempts` the
   * step parks on the iteration-cap gate (`exceeded`) for a human rather than failing.
   * A human "request changes" on the companion's gate also re-runs the producer but does
   * NOT consume `attempts` (only the automatic loop is budgeted). Absent for non-companion steps.
   */
  companion: v.optional(
    v.nullable(
      v.object({
        /** The quality bar (0..1) the latest verdict's rating must reach; seeded from the pipeline. */
        threshold: v.number(),
        /** The automatic rework budget: once `attempts` reaches this the gate parks for a human (`exceeded`). */
        maxAttempts: v.number(),
        /**
         * How many AUTOMATIC reworks the companion has driven so far (the producer is
         * looped back once per failed verdict). Human "request changes" cycles are not
         * counted. Defaults to 0; once it reaches `maxAttempts` the step parks on the
         * iteration-cap gate (`exceeded`) — an "extra round" raises `maxAttempts` by one.
         */
        attempts: v.optional(v.number(), 0),
        /**
         * One standardized {@link companionVerdictSchema} per grading cycle, in order —
         * the full sequence of correction iterations (the producer is re-run after each
         * rejected verdict), including any human-driven ones. Empty before the first
         * grade; the last entry is the latest.
         */
        verdicts: v.array(companionVerdictSchema),
        /**
         * Set true when the automatic rework budget (`maxAttempts`) was spent with the
         * rating still below the bar: instead of failing the run, the step parks on its
         * approval gate for a human to resolve via the shared iteration-cap surface
         * (one more round / proceed anyway / stop & reset). Cleared once the human grants
         * an extra round (the loop resumes). Absent until/unless the cap is hit.
         */
        exceeded: v.optional(v.boolean()),
      }),
    ),
  ),
  /**
   * Live Follow-up companion state while a `coder` step runs/parks: the items the Coder
   * streamed (loose ends / side-tasks / questions), whether the companion is enabled, and
   * the send-back loop budget. Items accrue live as the harness streams them (the blinking
   * companion); at the step's completion the engine parks the run while any item is
   * `pending`, then loops the Coder for any `queued` follow-up / `answered` question. See
   * {@link followUpsStepStateSchema}. Absent for non-`coder` steps / when the companion is off.
   */
  followUps: v.optional(v.nullable(followUpsStepStateSchema)),
  /**
   * Live implementation-fork decision state while a `coder` step runs its optional
   * two-phase flow: the proposer explore job (`proposing`), the human park
   * (`awaiting_choice` / `answering`), the resolved choice (`chosen`), or one of the
   * pass-through terminals (`single_path` / `skipped`). Created lazily by the engine
   * when the phase activates — the config lives on the block + the risk policy, never
   * on the step. Absent for non-`coder` steps / when the phase never activated. See
   * {@link forkDecisionStepStateSchema}.
   */
  forkDecision: v.optional(v.nullable(forkDecisionStepStateSchema)),
  /**
   * Live "Ralph loop" state carried on a `ralph` step: the persistent retry-until-done
   * loop's iteration count, budget, validation command, and per-iteration history. Seeded
   * from the block's per-task agent config at step start, then advanced each iteration by
   * the engine's `RalphController`. Because it rides the run's persisted `detail` blob, both
   * durable drivers + both stale-run sweepers re-drive a mid-loop run from exactly this
   * state after a restart. Absent for non-`ralph` steps. See {@link ralphStepStateSchema}.
   */
  ralph: v.optional(v.nullable(ralphStepStateSchema)),
  /**
   * Transient re-entry marker carried on a parked `coder` step whose fork decision is
   * `answering`: set when the human sends a chat message so the run is signalled to
   * wake and the durable driver, on re-entering, runs the inline chat LLM and appends
   * the assistant reply (the LLM work that must not block the HTTP request). Cleared
   * once that async cycle completes. Documented beside `pendingIncorporation` /
   * `pendingInterview`. Absent when no chat turn is pending.
   */
  pendingForkChat: v.optional(v.nullable(v.object({ messageId: v.string() }))),
  /**
   * Live PR deep-review state carried on a `pr-reviewer` step: the sliced, severity-ordered
   * findings the read-only reviewer produced, the human's curated selection, and how it was
   * resolved. Recorded by the engine when the reviewer container job completes; the run then
   * parks (`awaiting_selection`) for the human to select findings through the dedicated
   * window and resolve. Absent for non-`pr-reviewer` steps. See {@link prReviewStepStateSchema}.
   */
  prReview: v.optional(v.nullable(prReviewStepStateSchema)),
  /**
   * The at-most-once driver marker for the PR-review "post" resolution: set when the human
   * resolves a parked review with `post`, so the durable driver — on re-entry, off the HTTP
   * request — publishes the selected findings as inline PR review comments (via
   * `RepoFiles.createReview`) exactly once. Consumed (cleared + persisted) BEFORE the posting
   * side effect so a Workflows retry/replay can't post the review twice. Cleared once posted.
   */
  pendingPrReviewPost: v.optional(v.nullable(v.boolean())),
  /**
   * The transient driver marker for a PR-review "challenge": set when a human challenges a
   * finding, naming the finding + their optional specific concern, so the durable driver — on
   * re-entry, off the HTTP request — dispatches the read-only Challenge Investigator against that
   * finding exactly once. Consumed when the investigator's verdict is applied (the finding is
   * strengthened or retracted) and the review re-parks. Absent when no challenge is in flight.
   */
  pendingChallenge: v.optional(
    v.nullable(v.object({ findingId: v.string(), question: v.optional(v.nullable(v.string())) })),
  ),
  /**
   * Transient rework feedback carried on a PRODUCER step while it is being re-run by
   * a downstream companion (the analogue of an approval's `changes_requested`
   * feedback for the automatic path). Folded into the agent's revision context on the
   * re-run, then cleared. Absent when no companion rework is in flight.
   */
  rework: v.optional(
    v.nullable(
      v.object({
        /** The producer's previous proposal the companion challenged. */
        previousProposal: v.string(),
        /** The companion's prose feedback driving the rework. */
        feedback: v.string(),
        /** Optional per-item / per-block challenges to address. */
        comments: v.optional(v.array(stepReviewCommentSchema)),
      }),
    ),
  ),
  /**
   * Transient incorporation intent carried on a parked `requirements-review` gate step.
   * Set when the human answers the findings and asks to incorporate: the run is signalled
   * to wake and the durable driver, on re-entering the gate, folds the answers into a
   * document and re-reviews it (the LLM work that used to block the HTTP request). Cleared
   * once that async cycle completes. `feedback` is the human's optional "do it differently"
   * direction (a redo). Absent when no incorporation is pending.
   */
  pendingIncorporation: v.optional(v.nullable(v.object({ feedback: v.optional(v.string()) }))),
  /**
   * Transient recommendation intent carried on a parked `requirements-review` gate step.
   * Set when the human asks the Requirement Writer to suggest answers for a batch of findings
   * (or re-requests one): the run is signalled to wake and the durable driver, on re-entering
   * the gate, runs the Writer per finding — filling in the `pending` placeholder
   * recommendations — then re-parks (recommendations never advance the run). Cleared once that
   * async batch completes. `itemIds` are the findings to recommend for; `note` steers the
   * whole batch. Absent when no recommendation batch is pending.
   */
  pendingRecommendation: v.optional(
    v.nullable(v.object({ itemIds: v.array(v.string()), note: v.optional(v.string()) })),
  ),
  /**
   * Transient interview intent carried on a parked `initiative-interviewer` gate step. Set
   * when the human has answered the planning questions and asked to continue (or proceed):
   * the run is signalled to wake and the durable driver, on re-entering the gate, runs the
   * interviewer LLM again against the answers — asking follow-ups (re-park) or synthesizing
   * the goal/constraints brief and advancing. `proceed` skips any remaining questions.
   * Cleared once that async re-entry completes. Absent when no continuation is pending.
   */
  pendingInterview: v.optional(v.nullable(v.object({ proceed: v.optional(v.boolean()) }))),
  /**
   * Consensus configuration for this step, copied from the pipeline's `consensus`
   * array at run start. Present (with `enabled: true`) when this step should run
   * through the multi-model consensus mechanism; read by the consensus executor
   * (and to decide gating against the block estimate). Absent ⇒ standard agent.
   * See {@link consensusStepConfigSchema}.
   */
  consensus: v.optional(v.nullable(consensusStepConfigSchema)),
  /**
   * Estimate-based gating for this step, copied from the pipeline's `gating` array at
   * run start. When present (with `enabled: true`) the step is skipped at runtime unless
   * the block's task estimate meets the threshold. Absent ⇒ always run. See
   * {@link stepGatingSchema}.
   */
  gating: v.optional(v.nullable(stepGatingSchema)),
  /**
   * Per-step options bag copied from the pipeline's `stepOptions` array at run start (see
   * {@link stepOptionsSchema}). Absent ⇒ all defaults for this step. Read by the engine —
   * e.g. the requirements-review gate consults `stepOptions.autoRecommend`.
   */
  stepOptions: v.optional(v.nullable(stepOptionsSchema)),
  /**
   * True when this step was skipped at runtime because its `gating` was not satisfied
   * (the task estimate fell below the threshold). The step's `state` is `done` with no
   * output; the UI renders it as "skipped (gated)". Absent ⇒ the step ran normally.
   */
  skipped: v.optional(v.boolean()),
  /**
   * Set `true` on a `spec-writer` step that determined the task is purely technical and
   * produced no business specs (its result's `noBusinessSpecs`). Recorded on the step so
   * the spec-companion's convergence — the one point both signals coexist — can combine it
   * with the companion's `technicalCorroborated` verdict to infer the block's `technical`
   * label. Absent for every other kind / a writer that produced specs.
   */
  noBusinessSpecs: v.optional(v.boolean()),
  /**
   * Set on a `spec-companion` step from its `technicalCorroborated` verdict (whether it
   * agreed the task is purely technical). Recorded on the step — not just read off the
   * live assessment — so the engine can infer the block's `technical` label both on the
   * companion's automatic convergence AND on a human "proceed" past the iteration cap,
   * where only the persisted step survives. Absent for every other kind / no opinion.
   */
  technicalCorroborated: v.optional(v.boolean()),
  /** Text the agent produced for this step (when LLM execution is enabled). */
  output: v.optional(v.string()),
  /**
   * The structured JSON a registered CUSTOM kind's agent step returned (the generic
   * manifest-driven `agent` dispatch's `custom` channel). Recorded so the SPA can render
   * it in the `generic-structured` result view (and a post-op already consumed it
   * server-side). Absent for built-in / prose kinds.
   */
  custom: v.optional(v.unknown()),
  /** Identifier of the model that produced `output`, for transparency. */
  model: v.optional(v.string()),
  /**
   * Ids of the prompt-fragment library entries that were folded into this step's
   * system prompt — the manual selection on the block unioned with the relevance
   * selector's pick. Recorded for observability and replay-stability; absent when
   * the fragment-library module is not configured.
   */
  selectedFragmentIds: v.optional(v.array(v.string())),
  /**
   * A code/PR review step's per-best-practice-standard adherence report: for each
   * best-practice fragment folded into the reviewer's prompt, a 1..10 rating of how well the
   * reviewed change/PR adheres plus the issues that standard surfaced. Recorded by the engine
   * from the review agent's output and surfaced in run details / the PR-review window. Empty
   * when the reviewer reported no reachable standards; absent for every non-review step.
   */
  fragmentAdherence: v.optional(fragmentAdherenceSchema),
  /**
   * A container agent's self-assessment of the work it just did — how hard/easy it was, what
   * reduced its effectiveness, and the key obstacles it hit (see {@link agentEffortReportSchema}).
   * Recorded by the engine from the agent's sentinel-file report and surfaced in run details.
   * Absent for inline agents, non-container steps, and runs on an older harness image.
   */
  effortReport: v.optional(agentEffortReportSchema),
  /**
   * The repo-sourced Claude Skill this step was PINNED to at dispatch (a `skill` step; see
   * `docs/initiatives/repo-skills.md`). Recorded so a run executes a stable version of the
   * skill even if its source resyncs mid-run, and so a later investigation knows exactly
   * which skill (and at which commit / manifest blob) ran. `commit` is the source dir's head
   * commit the resources were fetched at (null if the skill was never synced to a commit);
   * `sha` is the `SKILL.md` blob sha. Absent for every non-`skill` step.
   */
  skillVersion: v.optional(
    v.object({
      skillId: v.string(),
      commit: v.nullable(v.string()),
      sha: v.string(),
    }),
  ),
  /**
   * Identifier of an in-flight asynchronous agent job (a container run polled by
   * the durable driver). Set while the step is dispatched-but-not-yet-finished so
   * a Workflows replay re-attaches to the running job instead of starting a new
   * one; cleared once the job's result is recorded.
   */
  jobId: v.optional(v.string()),
  /**
   * Epoch ms the step first began executing (transitioned to `working`). Set once
   * and never overwritten on subsequent state changes, so a re-run/replay keeps the
   * original start. Absent until the step starts.
   */
  startedAt: v.optional(v.nullable(v.number())),
  /**
   * Epoch ms the step finished (transitioned to `done`). With {@link startedAt}
   * this yields the step's execution duration. Absent until the step completes.
   */
  finishedAt: v.optional(v.nullable(v.number())),
  /**
   * Epoch ms of the container agent's last observed sign of life, forwarded from the harness
   * heartbeat (job start, then every stdout chunk / subagent transcript tail) and persisted here
   * THROTTLED — only re-stamped once the heartbeat has advanced by a bounded window, so a live
   * container's poll cadence doesn't rewrite the run on every tick. Distinct from {@link startedAt}
   * (a fixed clock) and from `subtasks`/`progress` (which only move when the agent ticks its todo
   * list): a long, quiet phase — a reviewer reading hundreds of files — advances THIS but not the
   * subtask counts, so the UI can surface "active Ns ago" and tell a genuinely-active-but-quiet run
   * apart from a wedged one. Its persistence also keeps the run's `updated_at` fresh so the stale-run
   * sweeper doesn't treat a live-but-quiet run as orphaned. Only ever set on async (container) steps;
   * cleared on re-run; absent on non-container steps, steps not yet polled, and older harness images.
   */
  lastActivityAt: v.optional(v.nullable(v.number())),
  /**
   * Epoch ms the step parked on a human (an approval gate, a raised decision, or an
   * iteration-cap gate), freezing its duration clock: while parked, elapsed time stops
   * accruing — the symmetric counterpart of {@link finishedAt}'s terminal freeze, so a
   * step waiting on input is not billed for the human's deliberation. Set once on park,
   * cleared (null) when the step resumes working or finishes. Absent until first parked.
   */
  pausedAt: v.optional(v.nullable(v.number())),
  /**
   * How many times this step's container was evicted/crashed and recovered by
   * automatically re-dispatching a fresh container (bounded by
   * `MAX_EVICTION_RECOVERIES`). Once spent, a further eviction fails the run as
   * `evicted` rather than looping. Absent/0 until the first eviction.
   */
  evictionRecoveries: v.optional(v.number()),
  /**
   * How many times this step's container was evicted by *transient infrastructure
   * churn* — an event the runtime facade flags as not-a-crash (e.g. a deploy
   * draining the sandbox) — and recovered by re-dispatching a fresh container.
   * Counted separately from {@link evictionRecoveries} and bounded by a larger
   * `MAX_TRANSIENT_EVICTION_RECOVERIES`, since such churn can recur several times in
   * a short window, unlike a crash. Absent/0 until the first transient eviction.
   */
  transientEvictionRecoveries: v.optional(v.number()),
  /**
   * The transport's post-mortem of the FIRST container to die on this step (its exit state plus
   * a tail of its own logs). Retained across recoveries: a re-dispatch removes the dead
   * container immediately, so evidence from the first death — usually the informative one, the
   * later attempts being a fresh container hitting the same wall — survives nowhere else. Folded
   * into the run's failure `detail` once the eviction budget is spent. Absent when the transport
   * reported no post-mortem (or the step was never evicted).
   */
  firstEvictionDetail: v.optional(v.string()),
  /**
   * The service-provisioning config a `deployer` step PINNED when it dispatched its async,
   * container-backed deploy job, so the later poll/finalize maps the job against the same config
   * the container was built from — NOT a fresh read of the service frame (which a person may have
   * edited mid-flight, e.g. flipping it to `infraless`, which would otherwise fail a deploy whose
   * container already succeeded). Absent for the synchronous raw-manifest path and the undeclared
   * legacy single-connection path (re-resolution is harmless there). See {@link serviceProvisioningSchema}.
   */
  deployProvisioning: v.optional(serviceProvisioningSchema),
  /**
   * A `deployer` step fanning out over several service frames (the task's own frame + each
   * involved-service frame; see the connections initiative) records each frame's TERMINAL
   * outcome here, keyed by frame block id — so a durable replay knows which frames are already
   * provisioned and only the remaining ones are dispatched. The in-flight frame is tracked by
   * {@link deployFrameId} + {@link jobId} until it settles into this map. Absent for a
   * single-frame deploy that never fanned out. See {@link deployEnvsSchema}.
   */
  deployEnvs: v.optional(deployEnvsSchema),
  /**
   * The service FRAME the deployer step's currently in-flight deploy job ({@link jobId}) is
   * provisioning, during a multi-env fan-out — so the poll/finalize maps the settled job onto the
   * right frame's {@link deployEnvs} entry. Cleared once that frame settles; absent when no deploy
   * job is in flight or the step never fanned out.
   */
  deployFrameId: v.optional(v.string()),
  /**
   * The task's OWN (primary) service frame, pinned on the FIRST target resolution of a `deployer`
   * fan-out and reused on every re-entry/replay. Keeps the primary classification STABLE against a
   * mid-flight reparent (which would otherwise re-derive a different own frame and flip an
   * own-service provisioning failure from terminal to a non-terminal peer failure — completing the
   * run `done` despite a failed deploy). Absent until the first resolution / for a step that never
   * fanned out.
   */
  deployPrimaryFrameId: v.optional(v.string()),
})
export type PipelineStep = v.InferOutput<typeof pipelineStepSchema>

export const executionStatusSchema = v.picklist(['running', 'blocked', 'done', 'paused', 'failed'])
export type ExecutionStatus = v.InferOutput<typeof executionStatusSchema>

/**
 * Per-run diagnostic context captured for AFTER-THE-FACT investigation of a run (esp. a
 * failure) — the "where/what did this run actually execute on" facts that were previously
 * spread across the DB (repo↔service↔installation joins), the harness transcript (model), or
 * lost entirely (which backend a step ran on). Stamped by the engine at dispatch and refined
 * on the first poll; it reflects the MOST RECENT container-step dispatch (the step most likely
 * relevant to a failure), not a per-step history. Rides in the run's `detail` JSON (no dedicated
 * column), like {@link ExecutionInstance.notes}/`frontendBindings`. Absent on legacy runs and on
 * runs with no container step (pure inline/gate pipelines). NEVER carries a token or secret.
 */
export const runDiagnosticsSchema = v.object({
  /** Context of the most recent container-step dispatch. */
  lastDispatch: v.optional(
    v.object({
      /** Index of the dispatched step within the pipeline. */
      stepIndex: v.number(),
      /** The step's agent kind (`coder`, `merger`, a custom kind, …). */
      agentKind: v.string(),
      /** Resolved model ref `provider:model` (e.g. `anthropic:claude-opus-4-8`); null if unresolved. */
      model: v.optional(v.nullable(v.string())),
      /**
       * Which runner backend the step actually ran on — the datum that distinguishes a native
       * host-process run from a sandboxed container: `local-native` | `local-container` |
       * `runner-pool` | `cloudflare-container`. Filled on the first poll (the transport reports
       * it); absent until then or on an older runtime.
       */
      executionBackend: v.optional(v.string()),
      /** The repo the step operated on. */
      repo: v.optional(
        v.object({
          owner: v.string(),
          name: v.string(),
          /** The base branch the work branched from. */
          baseBranch: v.optional(v.string()),
          /** VCS provider (`github` | `gitlab`), resolved from the run's repo origin. */
          provider: v.optional(v.string()),
        }),
      ),
      /** Epoch ms the dispatch was recorded. */
      at: v.number(),
    }),
  ),
  /**
   * The control-plane (orchestrator) host running the engine — NOT necessarily where the agent
   * ran (a container step runs elsewhere; see `lastDispatch.executionBackend`). `platform` is the
   * orchestrator's `process.platform` (e.g. `win32` pins a Windows local deployment — the class
   * of host that surfaced the native-Windows git-auth break). Best-effort.
   */
  host: v.optional(
    v.object({
      platform: v.optional(v.string()),
    }),
  ),
})
export type RunDiagnostics = v.InferOutput<typeof runDiagnosticsSchema>

export const executionInstanceSchema = v.object({
  id: v.string(),
  blockId: v.string(),
  pipelineId: v.string(),
  pipelineName: v.string(),
  steps: v.array(pipelineStepSchema),
  currentStep: v.number(),
  status: executionStatusSchema,
  /**
   * Structured failure diagnostics when `status` is `failed`; absent/null
   * otherwise. Lets a failed task surface the same failure banner + retry as a
   * failed bootstrap (shared {@link agentFailureSchema}).
   */
  failure: v.optional(v.nullable(agentFailureSchema)),
  /**
   * Failures from the run's PRIOR attempts, oldest→newest. Each retry/restart appends
   * the then-current {@link failure} here and clears `failure` on the fresh attempt, so
   * the top failure banner (keyed on `status === 'failed'`) disappears once the task is
   * restarted while the full error trail stays viewable in the "previous errors" history.
   * Absent/empty for a run that has never been failed-then-retried.
   */
  failureHistory: v.optional(v.array(agentFailureSchema)),
  /**
   * Successful outputs from the run's PRIOR attempts that a restart discarded, oldest→newest —
   * the positive complement of {@link failureHistory}. A restart-from-step resets the chosen
   * step and every later one, dropping their `output`; those that had already SUCCEEDED are
   * recorded here (attributed by `stepIndex`) so the step-detail overlay's execution history
   * surfaces the successful outputs a restart superseded, not only the errors. Bounded in count
   * and per-entry size so the run's `detail` JSON doesn't bloat. Absent/empty for a run never
   * restarted past a completed step (a plain retry re-runs only unfinished steps, so it records
   * nothing).
   */
  outputHistory: v.optional(v.array(priorStepOutputSchema)),
  /**
   * Non-fatal advisories computed once at run start — today the frontend UI-test flow's
   * resolved-binding notes ({@link buildFrontendRunNotes}: duplicate env vars, or a partial-live
   * set of bound services where some fall back to WireMock). Mirrors the harness's own
   * `buildInfraNotes` but surfaced on the RUN so the SPA renders it in the run/step detail
   * (distinct from a `failure`, which aborts the run). Absent/empty when there is nothing to
   * flag. Rides in the `detail` JSON column (no dedicated column), reflecting the start-time
   * state even after the underlying envs change.
   */
  notes: v.optional(v.array(v.string())),
  /**
   * The frontend UI-test flow's backend bindings RESOLVED once at run start (env var → the bound
   * service's live ephemeral URL, or absent ⇒ mocked; see {@link resolveFrontendBindings}). Stamped
   * on the run so the SPA's run/step detail projects what the run ACTUALLY drove against — a frozen
   * snapshot that stays truthful after the underlying envs are torn down, rather than re-resolving
   * against current live state (which for a finished run could disagree with the co-located
   * start-time {@link notes}). Rides in the `detail` JSON column; absent for a non-frontend run.
   */
  frontendBindings: v.optional(v.array(resolvedFrontendBindingSchema)),
  /**
   * Internal user id (`usr_*`) of whoever started this run (or retried it). Recorded
   * so the individual-usage restricted mode can use the initiator's OWN personal
   * subscription (e.g. Claude) for the run's steps — a personal credential is never
   * shared, so only its owner's runs may use it. Absent for runs started without a
   * signed-in user (auth-disabled/local dev) and for legacy runs.
   */
  initiatedBy: v.optional(v.nullable(v.string())),
  /**
   * Epoch-ms creation time, stamped when the run is first started. Gives a run a stable
   * creation timestamp independent of when its first step actually starts (the public-API
   * job view reports it as `createdAt`). Absent on legacy runs persisted before this field.
   */
  createdAt: v.optional(v.number()),
  /**
   * Optimistic-concurrency token: a monotonic revision of the persisted run row,
   * bumped on every write. Read back by the repository and used by
   * `compareAndSwap` so a human-action write (resolve decision / approve /
   * request changes) that raced another writer is detected and retried on fresh
   * state instead of silently clobbering it. Defaults to 0 for a run that has
   * never been persisted. The SPA's execution store also keys its monotonic
   * reconcile on it, so a lagging snapshot refresh can't regress a run a live
   * event already advanced.
   */
  rev: v.optional(v.number()),
  /**
   * After-the-fact investigation context — where/what the run's most recent container step
   * executed on (backend, model, repo) plus the control-plane host. Rides in the `detail` JSON
   * (see {@link runDiagnosticsSchema}); absent on legacy runs and pure inline pipelines.
   */
  diagnostics: v.optional(runDiagnosticsSchema),
})
export type ExecutionInstance = v.InferOutput<typeof executionInstanceSchema>
