import * as v from 'valibot'
import { subscriptionVendorSchema } from './vendor-credentials.js'
import { agentConfigValuesSchema } from './agent-config.js'
import { testReportSchema } from './testing.js'
import { cloudProviderSchema, instanceSizeSchema } from './provisioning.js'
import {
  agentKindSchema,
  agentStateSchema,
  blockLevelSchema,
  blockStatusSchema,
  blockTypeSchema,
  positionSchema,
  sizeSchema,
} from './primitives.js'

// ---------------------------------------------------------------------------
// Entity schemas: the single source of truth for the data shapes that travel
// over the wire. Domain types in @cat-factory/kernel are derived from these, and
// the worker validates responses against them, so frontend, core and facade can
// never silently drift apart.
// ---------------------------------------------------------------------------

/**
 * A lightweight link from a block to the pull request an implementation agent
 * opened for it. Distinct from the richer {@link GitHubPullRequest} projection
 * (synced from GitHub): this is just enough to display the PR on the board and
 * navigate to it. Recorded on a task when its container ("implementer") agent
 * pushes a branch and opens a PR.
 */
export const pullRequestRefSchema = v.object({
  /** The PR's web URL, opened when the user clicks through from the board. */
  url: v.string(),
  /** The PR number within the repo, shown as `#<number>` when known. */
  number: v.optional(v.number()),
  /** The head branch the agent pushed its work to, when known. */
  branch: v.optional(v.string()),
})
export type PullRequestRef = v.InferOutput<typeof pullRequestRefSchema>

export const blockSchema = v.object({
  id: v.string(),
  title: v.string(),
  type: blockTypeSchema,
  description: v.string(),
  position: positionSchema,
  /**
   * An explicit, user-set pixel size for the block (service frames are resizable
   * by dragging their borders). Absent means the board auto-sizes the frame from
   * its contents; present is the dragged size (the client never shrinks it below
   * the content's natural extent). Only frames carry this today.
   */
  size: v.optional(sizeSchema),
  status: blockStatusSchema,
  progress: v.number(),
  dependsOn: v.array(v.string()),
  executionId: v.nullable(v.string()),
  level: blockLevelSchema,
  parentId: v.nullable(v.string()),
  confidence: v.optional(v.number()),
  moduleName: v.optional(v.string()),
  /**
   * Ids of curated best-practice prompt fragments selected for this block. Their
   * bodies are composed into the agent system prompt at run time. The catalog
   * itself lives in @cat-factory/prompt-fragments and is served separately.
   */
  fragmentIds: v.optional(v.array(v.string())),
  /**
   * Id of the LLM model selected for this block from the shared model catalog
   * (see MODEL_CATALOG in @cat-factory/kernel). When set it overrides the agent
   * routing's default model at run time; absent means "use the routing default".
   */
  modelId: v.optional(v.string()),
  /**
   * Task-level configuration values contributed by the agents in the task's
   * pipeline (see {@link agentConfigValuesSchema}) — a sparse id→value map. Each
   * value is editable until its contributing agent's step starts, then freezes.
   * Used e.g. for the Tester's `tester.environment` (local vs ephemeral) choice.
   * Only meaningful on `task`-level blocks.
   */
  agentConfig: v.optional(agentConfigValuesSchema),
  /**
   * Service-level (frame-only): path to the service's docker-compose file used to
   * stand up the Tester's local infra dependencies, relative to the repo root
   * (e.g. `docker-compose.yml`). Autodiscovered when the service is added but may
   * be set later. Mutually exclusive with {@link noInfraDependencies}; a Tester
   * pipeline cannot start until one of the two is set.
   */
  testComposePath: v.optional(v.string()),
  /**
   * Service-level (frame-only): the service has no infra dependencies to stand up,
   * so the Tester spins nothing up. When true {@link testComposePath} is ignored.
   */
  noInfraDependencies: v.optional(v.boolean()),
  /**
   * Service-level (frame-only): the cloud provider this service's container jobs
   * run on. Absent means the owning account's `defaultCloudProvider`.
   */
  cloudProvider: v.optional(cloudProviderSchema),
  /**
   * Service-level (frame-only): the abstract instance size for this service's
   * container jobs, resolved to a provider-specific id at dispatch. Absent means
   * the built-in default size.
   */
  instanceSize: v.optional(instanceSizeSchema),
  /**
   * The pull request the block's implementation ("implementer") agent opened for
   * its work. Set on a task once its container agent pushes a branch and opens a
   * PR; surfaced on the board so the PR can be opened from the selected task.
   */
  pullRequest: v.optional(pullRequestRefSchema),
  /**
   * Id of the merge threshold preset selected for this task (see
   * {@link mergeThresholdPresetSchema}). Drives the `merger` step's auto-merge
   * decision and the CI-fixer attempt budget. Absent means "use the workspace's
   * default preset".
   */
  mergePresetId: v.optional(v.string()),
  /**
   * Id of the pipeline chosen for this task at creation (see {@link pipelineSchema}).
   * The task's "Start"/"Run" controls default to it; absent means the user picks a
   * pipeline at run time (the board falls back to the first defined pipeline).
   */
  pipelineId: v.optional(v.string()),
  /**
   * GitHub user id of the person who created this block, captured from the
   * authenticated session at creation (tasks today). Drives "notify the task
   * creator" routing for notifications. Absent/null on blocks created before this
   * was recorded, or with auth disabled (local/dev), where there is no user.
   */
  createdBy: v.optional(v.nullable(v.number())),
})
export type Block = v.InferOutput<typeof blockSchema>

/**
 * A curated best-practice "prompt fragment" (e.g. Node performance, React state
 * management). The catalog is authored in @cat-factory/prompt-fragments and
 * surfaced to the frontend read-only so a user can pick which apply to a block.
 */
export const promptFragmentSchema = v.object({
  /** Stable id, e.g. `node.performance`. Selection persists this. */
  id: v.string(),
  /** Semver of the body content, for display and future version pinning. */
  version: v.string(),
  /** Human title shown in the picker, e.g. `Node.js performance`. */
  title: v.string(),
  /** Grouping label for the picker, e.g. `Node`, `React`. */
  category: v.string(),
  /** One-line description shown in the picker. */
  summary: v.string(),
  /** The guidance injected into the agent system prompt. */
  body: v.string(),
  /** Optional hints for filtering which blocks/agents a fragment suits. */
  appliesTo: v.optional(
    v.object({
      blockTypes: v.optional(v.array(blockTypeSchema)),
      agentKinds: v.optional(v.array(agentKindSchema)),
    }),
  ),
  /**
   * Free-form tags used by the relevance selector to decide whether a fragment
   * is pertinent to a given run (e.g. `backend`, `frontend`, `db`). Optional and
   * absent on the built-in catalog tier; managed fragments may set them.
   */
  tags: v.optional(v.array(v.string())),
  /**
   * Provenance for a fragment sourced from a repo: which {@link FragmentSource}
   * it came from, the file path within that source, and the blob sha last synced
   * (so a "changed?" check is a cheap comparison). Absent for hand-authored
   * fragments and the built-in catalog.
   */
  source: v.optional(
    v.object({
      sourceId: v.string(),
      path: v.string(),
      sha: v.string(),
    }),
  ),
})
export type PromptFragment = v.InferOutput<typeof promptFragmentSchema>

/** The full catalog as served by `GET /prompt-fragments`. */
export const promptFragmentCatalogSchema = v.array(promptFragmentSchema)
export type PromptFragmentCatalog = v.InferOutput<typeof promptFragmentCatalogSchema>

/** Informational list price for a model, surfaced in the picker. */
export const modelCostSchema = v.object({
  /** List price per 1M input tokens. */
  inputPerMillion: v.number(),
  /** List price per 1M output tokens. */
  outputPerMillion: v.number(),
  /** ISO 4217 currency the prices are expressed in (e.g. `EUR`). */
  currency: v.string(),
})
export type ModelCost = v.InferOutput<typeof modelCostSchema>

/**
 * A selectable LLM model, resolved to the flavour actually in use for this
 * deployment (`GET /models`). `flavor` is `direct` when the model's own provider
 * API key is configured, `cloudflare` for the Workers AI fallback, or
 * `subscription` for a Claude Code / Codex model run via a stored subscription
 * token. `provider`/`model` are the effective {@link ModelRef} parts the agent
 * will run with; the picker stores only `id`.
 */
export const modelOptionSchema = v.object({
  /** Stable id persisted on a block (`Block.modelId`). */
  id: v.string(),
  /** Model-family label, e.g. `Qwen3`. */
  label: v.string(),
  /** One-line description shown in the picker. */
  description: v.string(),
  /** Which flavour is active for this deployment. */
  flavor: v.picklist(['cloudflare', 'direct', 'subscription']),
  /** Short provider label for the active flavour, e.g. `Cloudflare`, `DashScope`. */
  providerLabel: v.string(),
  /** Effective provider id the agent runs with. */
  provider: v.string(),
  /** Effective model id within the provider. */
  model: v.string(),
  /**
   * For a `subscription` model, the vendor whose pooled token authenticates it;
   * the frontend enables the option only when the workspace has a token for it.
   */
  vendor: v.optional(subscriptionVendorSchema),
  /** Informational list price for the model, when known. */
  cost: v.optional(modelCostSchema),
  /** The model's context window at the effective provider, when known. */
  contextTokens: v.optional(v.number()),
  /**
   * True when the effective flavour runs on a flat-rate subscription. Its `cost`
   * is illustrative of quota burn rate only — quota-based usage does NOT draw on
   * the monetary spend budget.
   */
  quotaBased: v.optional(v.boolean()),
  /**
   * An alternative subscription flavour for a model that ALSO has a Cloudflare /
   * direct base (e.g. GLM-5.2, Kimi). The frontend renders ONLY this flavour when
   * the workspace has a token for `vendor` (hiding the base), and the executor
   * always prefers it at dispatch. Absent for subscription-only models (whose base
   * IS the subscription) and for models with no subscription path.
   */
  subscription: v.optional(
    v.object({
      vendor: subscriptionVendorSchema,
      providerLabel: v.string(),
      provider: v.string(),
      model: v.string(),
      cost: v.optional(modelCostSchema),
      contextTokens: v.optional(v.number()),
    }),
  ),
})
export type ModelOption = v.InferOutput<typeof modelOptionSchema>

/** The full catalog as served by `GET /models`. */
export const modelCatalogSchema = v.array(modelOptionSchema)
export type ModelCatalog = v.InferOutput<typeof modelCatalogSchema>

export const pipelineSchema = v.object({
  id: v.string(),
  name: v.string(),
  agentKinds: v.array(agentKindSchema),
  /**
   * Per-step human approval gates, parallel to {@link agentKinds}: when
   * `gates[i]` is true the run pauses after step `i` completes so a human can
   * review (and edit) its proposal before the next step runs. Absent / shorter
   * than `agentKinds` means "no gate" for the missing indices, so legacy
   * pipelines run straight through unchanged.
   */
  gates: v.optional(v.array(v.boolean())),
  /**
   * Per-step companion quality thresholds, parallel to {@link agentKinds}: when step
   * `i` is a companion kind, `thresholds[i]` is the minimum rating (0..1) its review
   * must reach for the run to proceed; below it the preceding producer is re-run, and
   * the run fails once the rework budget is spent. `null`/absent on a companion step
   * means "use the companion's default threshold"; ignored on non-companion steps.
   */
  thresholds: v.optional(v.array(v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1))))),
})
export type Pipeline = v.InferOutput<typeof pipelineSchema>

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
 * One GitHub-review-style comment a human left on a specific block of an agent's
 * proposal while reviewing an approval gate. `quotedSource` is the verbatim raw
 * markdown of the block the comment targets (sliced from the proposal by its
 * source line range), so a "request changes" re-run can quote the agent's own
 * text back to it rather than a re-rendered approximation.
 */
export const stepReviewCommentSchema = v.object({
  /** Verbatim raw-markdown source of the commented block (or the rendered item text). */
  quotedSource: v.string(),
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
 */
export const agentRunKindSchema = v.picklist(['bootstrap', 'execution'])
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
 *   - `decision_timeout` — a human decision was not answered in time. [execution]
 *   - `rejected`         — a human rejected a gated proposal, stopping the run. [execution]
 *   - `cancelled`        — the user (or an orphan sweep) explicitly stopped the run.
 *   - `unknown`          — anything not otherwise classified.
 */
export const agentFailureKindSchema = v.picklist([
  'preflight',
  'dispatch',
  'evicted',
  'timeout',
  'agent',
  'job_failed',
  'decision_timeout',
  'rejected',
  // A companion agent's quality rating stayed below the step's threshold after the
  // automatic rework budget was exhausted, so the run was failed for human attention.
  'companion_rejected',
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
  /** Epoch ms the failure was recorded. */
  occurredAt: v.number(),
  /** Last subtask counts seen before the failure, for context (null if none). */
  lastSubtasks: v.nullable(stepSubtasksSchema),
})
export type AgentFailure = v.InferOutput<typeof agentFailureSchema>

/**
 * State a `ci` step carries while it gates a pull request on green CI. A `ci`
 * step is special (like a `deployer` step): it is not itself an LLM/container
 * agent — it polls GitHub check runs for the PR's head commit and, on failure,
 * dispatches the `ci-fixer` container agent to push a fix, looping until checks
 * pass or the attempt budget is spent.
 *   - `phase: 'checking'` — polling check runs for `headSha`.
 *   - `phase: 'fixing'`   — a `ci-fixer` job is in flight (tracked via the step's
 *                           `jobId`); on completion the step returns to `checking`.
 */
export const ciStepStateSchema = v.object({
  phase: v.picklist(['checking', 'fixing']),
  /** How many `ci-fixer` attempts have been dispatched so far. */
  attempts: v.number(),
  /** Ceiling on attempts, resolved from the task's merge preset at step start. */
  maxAttempts: v.number(),
  /** The PR head commit whose checks are being gated, once resolved. */
  headSha: v.optional(v.nullable(v.string())),
})
export type CiStepState = v.InferOutput<typeof ciStepStateSchema>

/**
 * State a `conflicts` step carries while it gates a pull request on being
 * mergeable. Like a `ci` step it is special (not an LLM/container agent itself):
 * it checks the PR's mergeability and, on a conflict, dispatches the
 * `conflict-resolver` container agent (which merges the base in, resolves the
 * conflicts and pushes), looping until the PR is mergeable or the budget is spent.
 *   - `phase: 'checking'`  — checking the PR's mergeability for `headSha`.
 *   - `phase: 'resolving'` — a `conflict-resolver` job is in flight (tracked via the
 *                            step's `jobId`); on completion the step returns to `checking`.
 */
export const conflictsStepStateSchema = v.object({
  phase: v.picklist(['checking', 'resolving']),
  /** How many `conflict-resolver` attempts have been dispatched so far. */
  attempts: v.number(),
  /** Ceiling on attempts, resolved from the task's merge preset at step start. */
  maxAttempts: v.number(),
  /** The PR head commit whose mergeability is being gated, once resolved. */
  headSha: v.optional(v.nullable(v.string())),
})
export type ConflictsStepState = v.InferOutput<typeof conflictsStepStateSchema>

/**
 * State a `tester` step carries while it runs the Tester → Fixer loop. Unlike `ci`,
 * the gate's own work IS a container job (the Tester); on a withheld greenlight the
 * engine loops a `fixer` container agent and re-tests.
 *   - `phase: 'testing'` — a Tester job is in flight (tracked via the step's `jobId`).
 *   - `phase: 'fixing'`  — a Fixer job is in flight; on completion the step returns to
 *                          `testing` and a fresh Tester job is dispatched.
 */
export const testerStepStateSchema = v.object({
  phase: v.picklist(['testing', 'fixing']),
  /** How many `fixer` attempts have been dispatched so far. */
  attempts: v.number(),
  /** Ceiling on fixer attempts, resolved from the task's merge preset at step start. */
  maxAttempts: v.number(),
  /** The most recent Tester report (what was tested, outcomes, concerns, greenlight). */
  lastReport: v.optional(v.nullable(testReportSchema)),
})
export type TesterStepState = v.InferOutput<typeof testerStepStateSchema>

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
  agentKind: agentKindSchema,
  state: agentStateSchema,
  progress: v.number(),
  /** LLM observability rollup for this step; see {@link stepMetricsSchema}. */
  metrics: v.optional(v.nullable(stepMetricsSchema)),
  /** Live CI-gate state while a `ci` step polls/fixes checks; see {@link ciStepStateSchema}. */
  ci: v.optional(v.nullable(ciStepStateSchema)),
  /** Live conflict-gate state while a `conflicts` step checks/resolves mergeability. */
  conflicts: v.optional(v.nullable(conflictsStepStateSchema)),
  /** Live Tester→Fixer loop state while a `tester` step runs/fixes; see {@link testerStepStateSchema}. */
  test: v.optional(v.nullable(testerStepStateSchema)),
  /** Live subtask counts while an async (container) step runs; see {@link stepSubtasksSchema}. */
  subtasks: v.optional(stepSubtasksSchema),
  /**
   * True while a container-backed step is being dispatched and its per-run
   * container is cold-booting — i.e. before the container is up and the agent has
   * begun executing. Set the moment the job is dispatched (the dispatch blocks
   * until the container accepts the job, so it covers the whole boot window) and
   * cleared on the first successful poll, when the container is provably up. Lets
   * the board show an explicit "Spinning up container…" phase instead of a blank
   * "working" state. Only ever set on async (container) steps.
   */
  startingContainer: v.optional(v.boolean()),
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
   * counts only the AUTOMATIC reworks performed, and the run fails once it reaches
   * `maxAttempts`. A human "request changes" on the companion's gate also re-runs the
   * producer but does NOT consume `attempts` (only the automatic loop is budgeted).
   * Absent for non-companion steps.
   */
  companion: v.optional(
    v.nullable(
      v.object({
        /** The quality bar (0..1) the latest verdict's rating must reach; seeded from the pipeline. */
        threshold: v.number(),
        /** The automatic rework budget: once `attempts` reaches this the run fails (`companion_rejected`). */
        maxAttempts: v.number(),
        /**
         * How many AUTOMATIC reworks the companion has driven so far (the producer is
         * looped back once per failed verdict). Human "request changes" cycles are not
         * counted. Defaults to 0; the run fails once it reaches `maxAttempts`.
         */
        attempts: v.optional(v.number(), 0),
        /**
         * One standardized {@link companionVerdictSchema} per grading cycle, in order —
         * the full sequence of correction iterations (the producer is re-run after each
         * rejected verdict), including any human-driven ones. Empty before the first
         * grade; the last entry is the latest.
         */
        verdicts: v.array(companionVerdictSchema),
      }),
    ),
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
  /** Text the agent produced for this step (when LLM execution is enabled). */
  output: v.optional(v.string()),
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
   * GitHub user id of whoever started this run (or retried it). Recorded so the
   * individual-usage restricted mode can use the initiator's OWN personal
   * subscription (e.g. Claude) for the run's steps — a personal credential is never
   * shared, so only its owner's runs may use it. Absent for runs started without a
   * signed-in user (auth-disabled/local dev) and for legacy runs.
   */
  initiatedBy: v.optional(v.nullable(v.number())),
})
export type ExecutionInstance = v.InferOutput<typeof executionInstanceSchema>

export const workspaceSchema = v.object({
  id: v.string(),
  name: v.string(),
  createdAt: v.number(),
  /** The account this board belongs to, or null for a legacy/unscoped board. */
  accountId: v.nullable(v.string()),
})
export type Workspace = v.InferOutput<typeof workspaceSchema>

/**
 * The spend safeguard's view of the current billing period. Token usage is
 * tracked per LLM call and priced into a single currency; once `costSpent`
 * reaches `costLimit` the engine pauses runs and the frontend shows a warning.
 * Global across all workspaces (an operator's budget is org-wide), attached to
 * every snapshot by the worker so the client can render the warning anywhere.
 */
export const spendStatusSchema = v.object({
  /** Start of the current billing period (epoch ms; calendar month, UTC). */
  periodStart: v.number(),
  /** Input (prompt) tokens consumed this period. */
  inputTokens: v.number(),
  /** Output (completion) tokens produced this period. */
  outputTokens: v.number(),
  /** Estimated cost of this period's usage, in `currency`. */
  costSpent: v.number(),
  /** Configured budget for one period, in `currency`. */
  costLimit: v.number(),
  /** ISO 4217 currency the costs are expressed in (e.g. `EUR`). */
  currency: v.string(),
  /** True once `costSpent >= costLimit`: runs are paused until the period rolls over. */
  exceeded: v.boolean(),
})
export type SpendStatus = v.InferOutput<typeof spendStatusSchema>

// The workspace snapshot schema lives in ./snapshot — it references
// `bootstrapJobSchema` from ./bootstrap, which itself imports from this file, so
// keeping it here would be a circular import.
