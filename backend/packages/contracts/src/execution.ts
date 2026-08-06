import * as v from 'valibot'
import { intakeOriginSchema, runDiagnosticsSchema, runModeSchema } from './run-provenance.js'
import { testConcernSchema, testReportSchema, testerInfraSetupSchema } from './testing.js'
import { consensusStepConfigSchema, stepGatingSchema } from './consensus.js'
import { followUpsStepStateSchema } from './followUp.js'
import { forkDecisionStepStateSchema } from './forkDecision.js'
import { judgeStepStateSchema } from './judge.js'
import { agentFailureKindSchema } from './agent-failure-kinds.js'
import { ralphStepStateSchema } from './ralph.js'
import { validationReportSchema } from './validation-checks.js'
import { reproductionReportSchema } from './reproduction.js'
import { prReviewStepStateSchema } from './prReview.js'
import { runInputGateSchema } from './input-gate.js'
import { fragmentAdherenceSchema } from './fragment-adherence.js'
import { agentEffortReportSchema } from './agent-effort.js'
import { foundationalServiceSelectionSchema } from './foundational-services.js'
import { binaryOutputReportSchema } from './binary-outputs.js'
import { stepToolServersSchema } from './tool-servers.js'
// The polling-GATE and the human-verdict-gate step-state clusters each live in their own
// module (the `forkDecision.ts` / `judge.ts` shape); `PipelineStep` composes them back in below.
import { gateStepStateSchema } from './gate.js'
import { humanTestStepStateSchema, visualConfirmStepStateSchema } from './human-verdict-gates.js'
import {
  environmentStatusSchema,
  infraEngineSchema,
  provisionTypeSchema,
  serviceProvisioningSchema,
  teardownConfirmationSchema,
} from './environments.js'
import { resolvedFrontendBindingSchema } from './frontend.js'
import { agentKindSchema, agentStateSchema } from './primitives.js'
import { stepOptionsSchema } from './entities.js'
import {
  companionVerdictSchema,
  decisionSchema,
  stepApprovalSchema,
  stepReviewCommentSchema,
} from './step-decisions.js'
import { workspaceRoleSchema } from './workspace-members.js'

// ---------------------------------------------------------------------------
// Run / execution runtime state: the shapes that describe an in-flight run and
// its steps' live state — subtasks, agent-run failures, the tester step-state
// machine, per-step metrics, the pipeline STEP (the runtime instance of a
// pipeline's step), and the execution instance itself. The gate (`gate.ts`),
// human-verdict-gate (`human-verdict-gates.ts`) and human-decision
// (`step-decisions.ts`: an agent's question, review comments, a companion
// verdict, the approval gate) clusters live in their own modules and are
// composed back into `PipelineStep` here.
// Split out of entities.ts (which keeps the board / pipeline-definition / model
// / workspace shapes); re-exported from the package barrel, so consumers are
// unaffected. Depends on entities.ts (for stepOptionsSchema); entities.ts does
// NOT depend back on this file.
// ---------------------------------------------------------------------------

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
 * Whether a decoded value is a usable {@link AgentFailure}. Validated against the FULL
 * schema, not just `kind`/`message`: the SPA re-validates the whole workspace snapshot
 * against {@link agentFailureSchema} (both the `failure` field and the `failureHistory`
 * array), so a structurally-incomplete record — a kind outside the picklist, OR a known
 * kind missing `occurredAt`/`detail`/`hint`/`lastSubtasks` — would brick the entire
 * snapshot decode if surfaced.
 */
export function isUsableAgentFailure(value: unknown): value is AgentFailure {
  return v.is(agentFailureSchema, value)
}

/**
 * The stored `agent_runs.failure` TEXT column → a usable failure, tolerating a null column,
 * an empty string and a malformed blob alike (all three mean "no structured failure
 * recorded"). Dropping an unusable record keeps the run readable — its `status`/`error`
 * still describe what happened — and, for the history, means a retry can't make a bad
 * record permanent.
 *
 * Shared rather than reimplemented per caller because EVERY run kind's repositories on
 * BOTH runtimes read this one column (execution, bootstrap, env-config-repair), and four
 * hand-rolled parsers had already drifted to a weaker `typeof kind === 'string'` check —
 * so one contract change left some stores surfacing a record the others dropped. It lives
 * here, beside the schema it validates against, rather than in a persistence layer,
 * because the runtimes' repositories must not have to reach into `@cat-factory/server` for
 * it (kernel deliberately carries no valibot dependency).
 */
export function parseStoredAgentFailure(raw: string | null | undefined): AgentFailure | null {
  if (!raw) return null
  try {
    const decoded: unknown = JSON.parse(raw)
    return isUsableAgentFailure(decoded) ? decoded : null
  } catch {
    // A blob we cannot read is not a failure record: read it exactly as an absent column.
    return null
  }
}

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
 * a polling gate's `gateAttemptSchema`, since a fixer run is otherwise an opaque
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
  /**
   * The registry id of the environment this frame got, recorded for a `ready` env at the moment
   * the deployer resolved its handle.
   *
   * This is the RUN's own record of WHICH environment it stood up, and it exists so that the
   * `disposer` at the other end of the lifecycle can reclaim exactly that one. Re-resolving the
   * environment from the frame later is not equivalent and is not safe: the block-and-frame read
   * falls back to the block's FRAME-LESS row (a manual or `human-test` environment) when the
   * frame's own row is gone, so a disposer running after a supersede, an operator's Destroy or a
   * TTL sweep would resolve — and destroy — an environment this run never provisioned.
   *
   * Absent on a `ready` frame means the deploy predates this field, and the disposer reports that
   * it could not identify the environment rather than guessing at one.
   */
  environmentId: v.optional(v.nullable(v.string())),
  /** The verbatim provider error for a `failed` env. */
  error: v.optional(v.nullable(v.string())),
})
export type DeployEnvState = v.InferOutput<typeof deployEnvStateSchema>

/** Per-frame deploy outcomes keyed by service-frame block id; see {@link deployEnvStateSchema}. */
export const deployEnvsSchema = v.record(v.string(), deployEnvStateSchema)
export type DeployEnvs = v.InferOutput<typeof deployEnvsSchema>

/**
 * The TERMINAL per-frame outcome of one environment a `disposer` step reclaimed, the mirror of
 * {@link deployEnvStateSchema} at the other end of the lifecycle:
 *  - `reclaimed`:  the environment was torn down. `confirmation` says whether an independent
 *                   probe then found it gone — only `confirmed` is proof (see
 *                   {@link teardownConfirmationSchema}).
 *  - `failed`:     the provider refused to tear it down; `error` carries the verbatim cause. The
 *                   environment is still standing and the TTL sweep is the remaining backstop.
 *  - `none`:       the frame had no live environment to reclaim (it was never provisioned, or
 *                   something already took it). Recorded rather than omitted, so a disposer that
 *                   found nothing is distinguishable from one that never reached the frame.
 *
 * `confirmation` is present only on `reclaimed`: the other two states have nothing to verify.
 */
export const disposeEnvStateSchema = v.object({
  status: v.picklist(['reclaimed', 'failed', 'none']),
  /** The environment id acted on, when there was one — the id an operator greps the logs for. */
  environmentId: v.optional(v.nullable(v.string())),
  /** Whether an independent probe confirmed the environment gone; `reclaimed` only. */
  confirmation: v.optional(v.nullable(teardownConfirmationSchema)),
  /** The verbatim provider error for a `failed` reclaim, or the probe's reason when it could
   *  not confirm one that otherwise succeeded. */
  error: v.optional(v.nullable(v.string())),
})
export type DisposeEnvState = v.InferOutput<typeof disposeEnvStateSchema>

/** Per-frame dispose outcomes keyed by service-frame block id; see {@link disposeEnvStateSchema}. */
export const disposeEnvsSchema = v.record(v.string(), disposeEnvStateSchema)
export type DisposeEnvs = v.InferOutput<typeof disposeEnvsSchema>

/**
 * Per-step LLM observability rollup: a compact aggregate over every model call the
 * step's container made, recorded by the LLM proxy and summed by the engine for the
 * board. It surfaces, at a glance, token usage, how close the step ran to its
 * output-token limit (truncation), the latency split between transport/proxy
 * overhead and actual model execution, and any errors/warnings. The full per-call
 * detail (prompts + responses) is fetched on demand for the drill-down panel.
 * Absent when the observability sink is not wired.
 */
/**
 * One PHASE's slice of a step's model spend — which part of the run's work the tokens went
 * to (the agent's own edit loop, a pre-PR validation repair round, a reproduction-proof
 * repair round, …), carried from the producer that owns the phase boundary. See
 * `docs/initiatives/token-burn-instrumentation.md`.
 */
export const stepPhaseMetricsSchema = v.object({
  /**
   * The phase label. `''` is the UNATTRIBUTED slice — an older harness image, an inline call,
   * the un-phased proxy path — and is a real row of the breakdown, never a gap: a run whose
   * calls are all `''` was metered by a channel with no phase concept, not one that spent
   * nothing outside the agent.
   */
  phase: v.string(),
  /** Model calls (turns) this phase spent. */
  calls: v.number(),
  /** Fresh (uncached) input tokens. */
  promptTokens: v.number(),
  /** Input tokens served from the provider's prefix cache. */
  cacheReadTokens: v.number(),
  /** Input tokens written INTO the cache. */
  cacheWriteTokens: v.number(),
  /** Completion (output) tokens. */
  completionTokens: v.number(),
  /**
   * Carry-cost proxy in token-turns: this phase's context summed against the turns that
   * still had to re-send it. It separates "this phase read a lot" from "this phase made
   * everything after it more expensive" — a large load early costs far more than the same
   * load at the end, and a plain token sum cannot tell the two apart. Comparable BETWEEN a
   * run's phases; meaningless as an absolute.
   */
  carryCostTokens: v.number(),
  /** Calls that failed (non-2xx / refused / in-process error). */
  errors: v.number(),
  /**
   * Estimated money this phase's tokens cost, in {@link stepMetricsSchema}'s `costCurrency`,
   * priced per input CLASS (a cache read at ~0.1x fresh, a cache write at ~1.25x).
   *
   * `null` ⇒ the deployment could not price it (no rate for that model, or no price table
   * wired); absent ⇒ a snapshot predating cost. Neither is `0`, which would claim the phase
   * was free. A run whose phases are all null shows tokens without money rather than a
   * confident zero.
   */
  costEstimate: v.optional(v.nullable(v.number())),
})
export type StepPhaseMetrics = v.InferOutput<typeof stepPhaseMetricsSchema>

export const stepMetricsSchema = v.object({
  /** Number of model calls recorded for this step. */
  calls: v.number(),
  /**
   * Sum of FRESH (uncached) input tokens across the step's calls — exclusive of both
   * cache classes, so the step's total input is
   * `promptTokens + cacheReadTokens + cacheWriteTokens`.
   */
  promptTokens: v.number(),
  /**
   * Sum of input tokens served from the provider's prefix cache (~0.1× base input).
   * 0 on a cache-less flavour (Workers AI). Absent ⇒ unknown (older snapshot).
   */
  cacheReadTokens: v.optional(v.number()),
  /**
   * Sum of input tokens written INTO the cache (1.25–2× base input, i.e. dearer than
   * fresh). Kept apart from the reads because a repair loop that keeps re-writing the
   * cache and one that only re-reads it look identical once they are summed. Absent ⇒
   * unknown (older snapshot).
   */
  cacheWriteTokens: v.optional(v.number()),
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
  /**
   * Carry-cost proxy in token-turns (see {@link stepPhaseMetricsSchema}), summed over the
   * step's phases. Absent ⇒ unknown (a snapshot predating the per-phase rollup).
   */
  carryCostTokens: v.optional(v.number()),
  /**
   * Estimated money this step's tokens cost, in {@link stepMetricsSchema}'s `costCurrency`.
   * See {@link stepPhaseMetricsSchema} for why `null` and absent are both kept apart from `0`.
   *
   * It is a LIST-PRICE estimate, not a bill: a subscription-harness step spent no per-token
   * money at all, and this reports what the same tokens would have cost metered.
   */
  costEstimate: v.optional(v.nullable(v.number())),
  /**
   * ISO 4217 currency `costEstimate` is denominated in — the deployment's spend currency, since
   * that is the currency its price table is written in. Carried BESIDE the amount rather than
   * assumed by the reader: the built-in table is EUR, a deployment may configure another, and a
   * bare number rendered under the wrong symbol is a wrong number.
   *
   * It labels every amount in this payload, so it is present whenever ANY of them exists: this
   * step's own `costEstimate` or one of its `byPhase` rows. Absent ⇒ nothing here is priced,
   * which is the only state where a reader has no amount to mislabel either. In particular a
   * step whose total is null because ONE phase ran on an unpriced model still carries the
   * currency, since its other phases carry real money.
   */
  costCurrency: v.optional(v.string()),
  /**
   * The step's burn split by the PHASE that spent it — the agent's own edit loop against a
   * pre-PR validation repair round against a reproduction-proof repair round, and so on. Rolled
   * up in SQL alongside the totals above (one `GROUP BY (agent_kind, phase)`), so it costs the
   * emit nothing extra.
   *
   * Absent ⇒ the sink is not wired or the snapshot predates the breakdown; EMPTY is
   * impossible whenever `calls > 0`, since an unattributable call lands in the `''` phase
   * rather than being dropped.
   */
  byPhase: v.optional(v.array(stepPhaseMetricsSchema)),
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
   * Live JUDGE state on a judge step (the fourth taxonomy bucket): the rubric identity, the
   * latest structured verdict, the per-task threshold it was compared against, the bounce
   * budget, and the round history. Created lazily by the engine on first entry and — like
   * `forkDecision` / `followUps` — deliberately PRESERVED across `resetStepForRerun`, so a
   * bounce that re-runs the producer plus this step does not erase the verdict it is looping
   * on. Absent for non-judge steps. See {@link judgeStepStateSchema}.
   */
  judge: v.optional(v.nullable(judgeStepStateSchema)),
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
   * The harness-computed PRE-PR VALIDATION report for a coding step whose service configured
   * validation checks: the latest attempt's per-command outcomes (exit code + a bounded,
   * secret-scrubbed output tail), how many agent+check rounds ran, and whether the checkout
   * ended green. Recorded by the engine from the runner result on BOTH the passing path (the
   * PR opened; this is the captured proof) and the exhausted path (the step failed; this is
   * the evidence). Rides the run's persisted `detail` blob — no migration. Absent when the
   * service configured no checks. See {@link validationReportSchema}.
   */
  validation: v.optional(v.nullable(validationReportSchema)),
  /**
   * Set when THIS dispatch could not READ the service frame's validation configuration (the
   * store threw, or a mothership node's persistence RPC did). The dispatch degrades to "no
   * checks and no dependency install" so a config-store outage cannot wedge every coding run,
   * and that degradation is byte-for-byte what a service configuring NEITHER produces, which
   * is exactly why the fact is recorded rather than only swallowed. Without it the PR
   * verification report states "this service configures no check commands" about a service
   * that may configure several, i.e. a fabricated fact about somebody's setup.
   *
   * Written at dispatch by `AgentContextBuilder`, and REWRITTEN on every dispatch of the step
   * (a re-dispatch whose read succeeds clears it), so the flag always describes the read that
   * produced the tree this step pushed. Rides the run's persisted `detail` blob, so no migration.
   */
  validationConfigUnreadable: v.optional(v.nullable(v.boolean())),
  /**
   * The harness-computed BUGFIX REPRODUCTION PROOF for a coding step that carried a declared
   * reproduction: the declared command run against the pre-fix tree and the final tree, with
   * both exit codes and captured output — or the agent's structural declaration that
   * reproduction was infeasible, with its reason and stated alternative verification. The
   * verdict is computed by the harness from exit codes, never self-reported by the model.
   * Recorded by the engine from the runner result on every outcome (an `inconclusive` verdict
   * never fails the step — see the initiative's D6). Rides the run's persisted `detail` blob —
   * no migration. Absent when the run was not opted in or carried no declaration. See
   * {@link reproductionReportSchema} and backend/docs/adr/0033-bugfix-reproduction-proof.md.
   */
  reproduction: v.optional(v.nullable(reproductionReportSchema)),
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
   * Whether {@link output} is a DETERMINISTIC RENDERING of a structured artifact the step
   * produced (the spec doc, the blueprint tree, the initiative plan) rather than the agent's
   * own prose — see `reviewableArtifactOutput`. The artifact itself was already ingested into
   * domain state (the spec files, the board frame, the `initiatives` entity), so the rendering
   * is a VIEW of that state, not its source.
   *
   * That makes the difference load-bearing at the approval gate: "approve with corrections"
   * overwrites `output` and flows it to downstream steps, which is exactly right for prose but
   * silently discards an edit here — the committed artifact is the ingested one, so the human's
   * corrections would never reach it. Both the SPA (hides the edit affordance) and
   * `approveStep` (refuses an edited proposal) read this. Absent/false ⇒ the output IS the
   * agent's own work product and stays editable.
   */
  outputIsRendered: v.optional(v.boolean()),
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
   * Subscription-usage attribution captured at DISPATCH, alongside {@link model}. An async
   * container job settles on the durable poll path, which rebuilds the job handle from what the
   * step persists — it cannot re-resolve any of this. Without these, the poll site attributes
   * a subscription run to nobody: the pooled-token usage feedback (usage-aware rotation) is
   * skipped outright and the quota-cycle counters resolve a null target, exactly as the model
   * itself used to record 'unknown'.
   *
   * Neither is a secret: `subscriptionTokenId` identifies the pool ROW whose credential was
   * leased (never the credential), and `initiatedByUserId` is the run's initiator, already
   * carried elsewhere in the run. Absent for a proxy-metered (non-subscription) job, and for a
   * run with no known initiator (system paths).
   */
  subscriptionTokenId: v.optional(v.string()),
  initiatedByUserId: v.optional(v.string()),
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
   * The repo-sourced Claude Skills this step was PINNED to at dispatch — the step's own picked
   * skill (a `skill` step) AND any CATALOG skills the running agent kind declared (see
   * `backend/docs/custom-agents.md` → agent capabilities). Recorded so a run executes a stable
   * version of each skill even if its source resyncs mid-run, and so a later investigation knows
   * exactly which skills (and at which commit / manifest blob) ran. `commit` is the source dir's
   * head commit the resources were fetched at (null if the skill was never synced to a commit);
   * `sha` is the `SKILL.md` blob sha. A BUNDLED skill (shipped in the deployment's own code) has
   * no pin — its version is the deployment's — so it never appears here. Absent when the step ran
   * no catalog skill.
   */
  skillVersions: v.optional(
    v.array(
      v.object({
        skillId: v.string(),
        commit: v.nullable(v.string()),
        sha: v.string(),
      }),
    ),
  ),
  /**
   * The tool servers (MCP) this dispatch wired for the agent, and the ones it declared and
   * dropped. The sibling of {@link skillVersions}, for the other half of the capability model.
   *
   * Recorded HERE rather than only in the agent-context telemetry snapshot, which already carried
   * the same facts in its untyped `extras` bag. Two reasons, and the first is the deciding one:
   * the snapshot is DOUBLE-GATED (`LLM_RECORD_PROMPTS` plus the per-workspace `storeAgentContext`),
   * so a surface reading it would be blank on a deployment that simply has prompt recording off,
   * while "which tools did this step actually have" is an ordinary question about a run, not an
   * opt-in debugging artifact. And a step outlives a snapshot, which is pruned on the telemetry
   * retention window.
   *
   * Absent for every non-container step. See {@link stepToolServersSchema} for why the two lists
   * are separate and why both-empty is its own state.
   */
  toolServers: v.optional(stepToolServersSchema),
  /**
   * The workspace agent-prompt revision this step was PINNED to at dispatch — the sibling of
   * {@link skillVersions}, and pinned for the same reason: what a step ran under must be
   * recoverable afterwards, and the prompt log is append-only, so re-reading it later would
   * answer about a revision that may have landed since.
   *
   * Absent when the kind ran the SHIPPED prompt — including after a deliberate revert, whose
   * head revision means "follow the built-in" and so pins nothing. So absent reads as "the
   * product's prompt", never as "unknown", which is what lets Kaizen treat an edited prompt as
   * its own `(prompt, agent, model)` combo instead of inheriting a verification earned by text
   * that is no longer running.
   */
  promptRevision: v.optional(v.number()),
  /**
   * The deployment-registered agent-kind VARIANT this step ran under, pinned at dispatch — the
   * sibling of {@link promptRevision}, for the same reason and one more.
   *
   * `stepOptions.agentVariantId` records what the pipeline ASKED for; this records what the
   * dispatch actually did with it, and the two genuinely differ. A variant's `systemPrompt` loses
   * to a workspace override (the narrower tier), and an id can be withdrawn mid-run — so a reader
   * shown only the ask would report a step as running a variation whose text never reached it.
   * `applied` keeps those causes apart (see `AgentVariantApplication`).
   *
   * `fingerprint` covers the text the variant CONTRIBUTED, which is what lets Kaizen treat a
   * re-worded variant as its own combo instead of inheriting a verification the previous wording
   * earned — a bare id cannot express that, since re-registering an id is a supported way to
   * re-word a variant. Absent when the variant contributed nothing, so it stays out of the key.
   *
   * Absent when the step named no variant, which is every step on the stock product.
   */
  promptVariant: v.optional(
    v.object({
      id: v.string(),
      applied: v.picklist(['full', 'addition-only', 'superseded', 'withdrawn']),
      fingerprint: v.optional(v.string()),
    }),
  ),
  /**
   * The FOUNDATIONAL SERVICES this step's agent declared its design consumes, read back from
   * its reply's machine-readable block (see `parseFoundationalDeclaration`). Written only by a
   * step whose kind carries the `foundational-catalog` trait — in the built-in catalog, the
   * architect.
   *
   * `declared` are ids that resolved against the workspace's catalog; `unknown` are ids the
   * agent named that did not. Kept apart because they need different downstream handling: the
   * first get their API contracts injected for the consumer kinds, the second are STATED to
   * those kinds as unavailable so nobody guesses at an interface the platform never had.
   *
   * ABSENT and `{declared: [], unknown: []}` are different states and both are load-bearing:
   * absent means no design step declared anything (it was skipped by estimate gating, or the
   * run predates the feature), while an empty selection means a design step ran and concluded
   * that no shared service applies. A consumer told the wrong one of those would either invent
   * a shared service or silently rebuild one.
   */
  foundationalServices: v.optional(foundationalServiceSelectionSchema),
  /**
   * What this step's agent DECLARED it stored, when its kind carries the `binary-output` trait
   * (a generator whose deliverable is binary artifacts pushed into a foundational storage
   * service, not a commit). Read back from the reply's fenced ```binary-outputs block by
   * `parseBinaryOutputDeclaration` and recorded beside the other job facts, before any
   * early-returning completion path.
   *
   * ABSENT means no binary-generating step settled here (the kind does not carry the trait, or
   * the run predates the feature) — distinct from a present report whose `undeclared` flag says
   * the agent never answered, and from an empty `stored`, which is the agent explicitly
   * reporting it stored nothing. See {@link binaryOutputReportSchema} for the bookkeeping.
   */
  binaryOutputs: v.optional(binaryOutputReportSchema),
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
   * Epoch ms the step began its FIRST attempt. Where {@link startedAt} is cleared and
   * re-stamped by `resetStepForRerun` (so it always names the attempt in flight), this one
   * survives the reset and never moves. It is what gives a re-run step a span covering
   * everything it did: external-trace children name their parent by the run + agent kind
   * alone, so attempt 1's generations hang under the same parent as attempt 3's, and a parent
   * starting at the LAST attempt would begin after its own earliest child. Absent until the
   * step starts.
   */
  firstStartedAt: v.optional(v.nullable(v.number())),
  /**
   * How many times this step has been STARTED (1 on a step that ran once, N after N-1
   * re-runs). Incremented on each fresh start, never cleared by `resetStepForRerun`, so a
   * cycle it drove is still countable after the fact. Distinct from the per-loop counters
   * (`gate.attempts`, `ralph.attempts`), which count dispatches WITHIN one start.
   */
  attempts: v.optional(v.number()),
  /**
   * Every agent kind DISPATCHED against this step, in first-dispatch order, with how many
   * times each ran.
   *
   * Usually just {@link agentKind} once, but a step routinely runs work under another kind: a
   * gate escalating to its helper (`ci-fixer` / `conflict-resolver` / `on-call`), a Tester
   * handing off to the fixer, a two-phase coder's `fork-proposer`. Those dispatches are what
   * every telemetry row is tagged with, so the run's own record of "what actually ran here"
   * cannot be `agentKind` alone. The COUNT is the cycle: a gate that dispatched its fixer four
   * times is the difference between a run that converged and one that thrashed, and it is
   * otherwise recoverable only from per-loop state each loop shapes differently.
   *
   * Written by `recordDispatchAttribution`, the one funnel every dispatch site already calls,
   * and never cleared by `resetStepForRerun`. Absent on a step that dispatched no container
   * agent (a gate whose precheck always passed, an inline-only step, a skipped step).
   */
  dispatches: v.optional(v.array(v.object({ agentKind: v.string(), count: v.number() }))),
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
  /**
   * A `disposer` step records each service frame's TERMINAL reclaim outcome here, keyed by frame
   * block id — the mirror of {@link deployEnvs} at the other end of the lifecycle, and, like it,
   * what lets a durable replay resume at the first un-settled frame instead of re-tearing down an
   * environment that is already gone. Absent until the disposer runs. See {@link disposeEnvsSchema}.
   */
  disposeEnvs: v.optional(disposeEnvsSchema),
})
export type PipelineStep = v.InferOutput<typeof pipelineStepSchema>

export const executionStatusSchema = v.picklist(['running', 'blocked', 'done', 'paused', 'failed'])
export type ExecutionStatus = v.InferOutput<typeof executionStatusSchema>

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
   * The workspace ROLE that initiator held at the moment the run was admitted, pinned here so the
   * merge decision can be scoped to it (`classRulesByRole`, `dryRunRoles`).
   *
   * PINNED rather than re-resolved, for two reasons. The merge settles on the durable driver's
   * path, which rebuilds its world from the run alone and has no request context to resolve a role
   * from — the same constraint that made `recordDispatchAttribution` record at dispatch. And it is
   * the honest fact: the authority a run was ADMITTED under is what the operator granted, so a
   * role change mid-run retunes the next run rather than silently re-governing one already in
   * flight.
   *
   * ABSENT is a real state, not a tier: a recurring-schedule fire, a public-API start and
   * auth-disabled dev all have no workspace role to pin. Such a run stays on the preset's base
   * `classRules` — the policy that governed it before role scoping existed — rather than being
   * guessed onto a role. Guessing either way is wrong in a way the other is not: `admin` hands an
   * unattributed run the widest rules in the preset, and `viewer` sandboxes a deployment's whole
   * schedule the day it first authors a role entry.
   */
  initiatedByRole: v.optional(v.nullable(workspaceRoleSchema)),
  /**
   * Whether this run may land its work ({@link runModeSchema}). Absent on legacy runs ⇒ `live`,
   * which is what they were. Carried forward across retry/restart: a dry run stays a dry run, or
   * the sandbox would be one retry deep.
   */
  mode: v.optional(runModeSchema),
  /**
   * HOW this run entered the system (`intakeOriginSchema`, which documents each member).
   * Distinct from `initiatedBy`, which is `null` for a public-API run, a recurring-schedule fire
   * AND auth-disabled dev alike, and from the launch-time `RunOrigin` (`manual`/`recurring`),
   * which gates pipeline availability and is not persisted. Recorded because clarification
   * behaviour diverges by intake: a headless run ({@link isHeadlessIntake}) pushes its parked
   * questions out to the task's linked tracker issue, whereas a UI-started task's overseer is in
   * the SPA and must keep behaving exactly as before. Carried forward across retry/restart.
   * Absent on legacy runs ⇒ treated as `ui` (the safe reading: no outbound question writeback
   * for a run whose intake we can't prove was headless).
   */
  intakeOrigin: v.optional(intakeOriginSchema),
  /**
   * Epoch-ms creation time, stamped when the run is first started. Gives a run a stable
   * creation timestamp independent of when its first step actually starts (the public-API
   * job view reports it as `createdAt`).
   *
   * On a run READ BACK from storage this is the `agent_runs.created_at` COLUMN — the value
   * chronological reads order by — so a keyset cursor minted from a run names exactly the
   * position the next query resumes at. The insert adopts whatever the instance was stamped with
   * at start (`adoptCreatedAt`), so the in-memory run and its row never disagree. Optional only
   * because a run assembled in memory has not been persisted yet.
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
  /**
   * The PRE-DISPATCH INPUT GATE's verdict on the task this run implements (see
   * {@link runInputGateSchema}): the structural check of the authored input that runs before
   * the first agent step is dispatched, so a task nobody could act on parks having spent no
   * tokens at all.
   *
   * ABSENT means the gate has not evaluated this run YET: the run has not reached its first
   * dispatch. It never means "clean": a clean evaluation stamps `passed`, and a workspace with
   * the gate off stamps `off`. Keeping those three apart is what makes the record idempotent
   * under a durable replay (a re-driven run reads its settled verdict rather than re-judging a
   * block a human has since edited) and what stops "the gate is off" from reading as "the input
   * is fine".
   */
  inputGate: v.optional(runInputGateSchema),
})
export type ExecutionInstance = v.InferOutput<typeof executionInstanceSchema>
