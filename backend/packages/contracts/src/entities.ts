import * as v from 'valibot'
import { subscriptionVendorSchema } from './vendor-credentials.js'
import { agentConfigValuesSchema } from './agent-config.js'
import { testReportSchema, testEnvironmentSchema } from './testing.js'
import { consensusStepConfigSchema, stepGatingSchema, taskEstimateSchema } from './consensus.js'
import { followUpsStepStateSchema } from './followUp.js'
import { cloudProviderSchema, instanceSizeSchema } from './provisioning.js'
import { releaseSignalSchema } from './release.js'
import { environmentStatusSchema } from './environments.js'
import { documentSourceKindSchema } from './documents.js'
import {
  agentKindSchema,
  agentStateSchema,
  blockLevelSchema,
  blockStatusSchema,
  blockTypeSchema,
  positionSchema,
  sizeSchema,
  taskTypeFieldsSchema,
  taskTypeSchema,
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

/**
 * Per-task override for an issue-tracker writeback action (see the workspace-level
 * `writebackCommentOnPrOpen` / `writebackResolveOnMerge` in tracker settings).
 * `on`/`off` force the behaviour for this task; absent ⇒ inherit the workspace setting.
 */
export const writebackOverrideSchema = v.picklist(['on', 'off'])
export type WritebackOverride = v.InferOutput<typeof writebackOverrideSchema>

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
  /**
   * Membership link to an `epic`-level block, INDEPENDENT of `parentId` (which
   * stays the structural container). A task carries its epic id here so an epic
   * can group tasks living under different modules/services; the epic is drawn
   * linked to all such members and its inspector lists them. Absent/null ⇒ not in
   * an epic. Only meaningful on `task`-level blocks.
   */
  epicId: v.optional(v.nullable(v.string())),
  /**
   * Preceding-task toggle: when this task's PR merges (it reaches `done`), the
   * engine automatically starts every task that `dependsOn` it and whose other
   * dependencies are also done. Off/absent ⇒ dependents wait for a manual start.
   * Only meaningful on `task`-level blocks.
   */
  autoStartDependents: v.optional(v.boolean()),
  confidence: v.optional(v.number()),
  /**
   * The `task-estimator` agent's triage of this task (complexity / risk / impact,
   * each 0..1, + rationale). Written by a `task-estimator` pipeline step once it
   * runs; surfaced in the UI and used to gate consensus steps. Absent until a
   * task-estimator step has run. Only meaningful on `task`-level blocks.
   */
  estimate: v.optional(v.nullable(taskEstimateSchema)),
  moduleName: v.optional(v.string()),
  /**
   * The kind of work this task represents (feature / bug / document / spike / recurring),
   * chosen by the human at creation. Drives the card's icon/badge, the per-type creation
   * fields, and the per-service running-task limit's optional per-type bucketing. Only
   * meaningful on `task`-level blocks; absent ⇒ treated as `feature`.
   */
  taskType: v.optional(taskTypeSchema),
  /**
   * Small per-type fields collected on the create-task form (see {@link taskTypeFieldsSchema}),
   * e.g. a bug's severity / repro steps, a spike's time-box. Only meaningful on `task`-level
   * blocks; absent ⇒ none collected.
   */
  taskTypeFields: v.optional(v.nullable(taskTypeFieldsSchema)),
  /**
   * Whether this task is purely TECHNICAL (a refactor / non-functional / internal change
   * with no externally-observable behaviour). When `true` the implementer treats the task
   * definition / incorporated requirements as the PRIMARY source of truth and the
   * committed specs as a regression-spotting reference, not the authority; the spec-writer
   * is free to produce no business specs. `false` is the explicit BUSINESS case: the
   * spec-writer is then required to produce specs (it is told not to claim "no business
   * specs"), and the implementer follows the spec as usual. A human may set it explicitly
   * (creation checkbox / inspector toggle); left unset it is inferred from the spec phase
   * (the writer's `noBusinessSpecs` + the spec-companion's corroboration). Only meaningful
   * on `task`-level blocks. `null`/absent ⇒ not yet determined (the engine may infer it).
   * Once a concrete `true`/`false` is recorded it is authoritative and the engine does NOT
   * re-infer over it — whether it was set by a human or a prior inference — for stability;
   * a human can still change it any time via the tri-state inspector toggle (unset /
   * technical / business, where "unset" sends `null` to re-open it to inference).
   */
  technical: v.optional(v.nullable(v.boolean())),
  /**
   * Ids of curated best-practice prompt fragments selected for this block. Their
   * bodies are composed into the agent system prompt at run time. The catalog
   * itself lives in @cat-factory/prompt-fragments and is served separately.
   */
  fragmentIds: v.optional(v.array(v.string())),
  /**
   * Service-level (frame-only): ids of the best-practice / guideline prompt fragments
   * selected as this service's programming standards (drawn from the universal pool in
   * @cat-factory/prompt-fragments). At run time the execution engine folds their bodies
   * into the system prompt of every agent under this service that carries the
   * `code-aware` trait. Seeded from the workspace default on new services; absent ⇒ no
   * service-level fragments (only the block's own `fragmentIds` apply).
   */
  serviceFragmentIds: v.optional(v.array(v.string())),
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
   * Service-level (frame-only): the default test environment a task under this
   * service is spawned with — `local` (the Tester stands the dependencies up via
   * {@link testComposePath} / {@link noInfraDependencies}) or `ephemeral` (it runs
   * against a provisioned environment). A task inherits this unless it overrides via
   * its `tester.environment` agent-config value. Absent ⇒ the built-in `ephemeral`.
   */
  defaultTestEnvironment: v.optional(testEnvironmentSchema),
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
   * Id of the model preset selected for this task (see {@link modelPresetSchema}).
   * Drives which model each agent step runs on (the preset's `overrides[kind] ??
   * baseModelId`) unless the block pins a model directly via {@link modelId}. Absent
   * means "use the workspace's default preset". Editable at any time; a change takes
   * effect on the task's NEXT step (steps already dispatched keep their model).
   */
  modelPresetId: v.optional(v.string()),
  /**
   * Id of the pipeline chosen for this task at creation (see {@link pipelineSchema}).
   * The task's "Start"/"Run" controls default to it; absent means the user picks a
   * pipeline at run time (the board falls back to the first defined pipeline).
   */
  pipelineId: v.optional(v.string()),
  /**
   * Internal user id (`usr_*`) of the person who created this block, captured from
   * the authenticated session at creation (tasks today). Drives "notify the task
   * creator" routing for notifications. Absent/null on blocks created before this
   * was recorded, or with auth disabled (local/dev), where there is no user.
   */
  createdBy: v.optional(v.nullable(v.string())),
  /**
   * Internal user id (`usr_*`) of the account member (a `product` role-holder) made
   * responsible for this task. They are notified when requirement review flags findings.
   * Absent/null when no responsible product person is assigned.
   */
  responsibleProductUserId: v.optional(v.nullable(v.string())),
  /**
   * Per-task override for the "comment on the linked tracker issue when a PR opens"
   * writeback action. Absent/null ⇒ inherit the workspace's `writebackCommentOnPrOpen`.
   * Only meaningful on `task`-level blocks that have a linked tracker issue.
   */
  trackerCommentOnPrOpen: v.optional(v.nullable(writebackOverrideSchema)),
  /**
   * Per-task override for the "close the linked tracker issue as resolved when its PR
   * merges" writeback action. Absent/null ⇒ inherit the workspace's `writebackResolveOnMerge`.
   * Only meaningful on `task`-level blocks that have a linked tracker issue.
   */
  trackerResolveOnMerge: v.optional(v.nullable(writebackOverrideSchema)),
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
  /**
   * Provenance for a fragment whose body is a **living** external document
   * (a Confluence/Notion page or a GitHub file). Unlike a repo `source`, a
   * document-backed fragment is NOT a one-time snapshot: at run time the engine
   * re-resolves the page's current content from the linked source (TTL-gated,
   * falling back to the last-resolved `body`). Absent for hand-authored, repo-
   * sourced, and built-in fragments.
   */
  documentRef: v.optional(
    v.object({
      source: documentSourceKindSchema,
      /** The source's stable id for the page/file (a valid import ref). */
      externalId: v.string(),
    }),
  ),
  /** When the document-backed body was last resolved from the source (epoch ms). */
  resolvedAt: v.optional(v.number()),
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
 * API key is configured, `openrouter` when it routes through the OpenRouter
 * gateway, `cloudflare` for the Workers AI fallback, or `subscription` for a
 * Claude Code / Codex model run via a stored subscription token. `provider`/`model`
 * are the effective {@link ModelRef} parts the agent will run with; the picker
 * stores only `id`.
 */
export const modelOptionSchema = v.object({
  /** Stable id persisted on a block (`Block.modelId`). */
  id: v.string(),
  /** Model-family label, e.g. `Qwen3`. */
  label: v.string(),
  /** One-line description shown in the picker. */
  description: v.string(),
  /** Which flavour is active for this deployment. */
  flavor: v.picklist(['cloudflare', 'direct', 'openrouter', 'subscription']),
  /**
   * Whether this model is actually selectable given what the workspace has
   * configured: a direct key for its provider, a subscription token for its vendor,
   * or the opt-in Cloudflare lib enabled. The picker disables an unavailable model.
   */
  available: v.optional(v.boolean()),
  /** Short provider label for the active flavour, e.g. `Cloudflare`, `DashScope`. */
  providerLabel: v.string(),
  /** Effective provider id the agent runs with. */
  provider: v.string(),
  /** Effective model id within the provider. */
  model: v.string(),
  /**
   * Whether the active flavour's provider caches the re-sent prompt prefix. False on
   * a Cloudflare/Workers-AI flavour (no caching), true once a direct key upgrades the
   * model to its caching `direct` flavour. The pickers surface this so a user can see
   * the hot path running cache-less and act on it (connect a direct key / pick a
   * caching model). Absent ⇒ unknown (older catalog).
   */
  cachesPrompts: v.optional(v.boolean()),
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
      cachesPrompts: v.optional(v.boolean()),
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
   * once the rework budget is spent the step parks for a human (the iteration-cap gate).
   * `null`/absent on a companion step means "use the companion's default threshold";
   * ignored on non-companion steps.
   */
  thresholds: v.optional(v.array(v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1))))),
  /**
   * Per-step enable flags, parallel to {@link agentKinds}: when `enabled[i]` is
   * explicitly `false` the step is kept in the pipeline (so it can be toggled back
   * on) but SKIPPED at run start — the execution instance is built only from the
   * enabled steps. Absent / shorter than `agentKinds`, or `true`, means the step
   * runs, so legacy pipelines run every step unchanged.
   */
  enabled: v.optional(v.array(v.boolean())),
  /**
   * Per-step consensus configuration, parallel to {@link agentKinds}: when
   * `consensus[i]` is set and its `enabled` is true AND step `i`'s kind carries a
   * consensus capability trait, the step runs through the multi-model consensus
   * mechanism (specialist panel / debate / ranked voting) instead of a single LLM
   * call — optionally gated on the task estimate (sub-threshold ⇒ standard agent).
   * `null`/absent means "standard single-actor agent" (the default). Copied onto
   * the run's step at start, like {@link gates}. See {@link consensusStepConfigSchema}.
   */
  consensus: v.optional(v.array(v.nullable(consensusStepConfigSchema))),
  /**
   * Per-step gating, parallel to {@link agentKinds}: when `gating[i]` is set and its
   * `enabled` is true, step `i` runs only if the task estimate meets the threshold
   * (OR across the supplied axes); otherwise it is transparently SKIPPED at runtime.
   * `null`/absent means "always run" (the default). Copied onto the run's step at
   * start, like {@link gates}. A pipeline with any enabled gating requires a
   * `task-estimator` step earlier in the chain. See {@link stepGatingSchema}.
   */
  gating: v.optional(v.array(v.nullable(stepGatingSchema))),
  /**
   * Per-step Follow-up companion toggle, parallel to {@link agentKinds}: governs whether a
   * `coder` step runs the future-looking Follow-up companion (the Coder surfaces loose ends /
   * side-tasks / questions, and the run parks at the step's completion until every item is
   * decided). `followUps[i] === false` disables it on that step; `null`/`true`/absent means
   * "enabled" — so a Coder step gets the companion by default. Ignored on non-`coder` steps.
   * Copied onto the run's step (`followUps.enabled`) at start, like {@link gates}.
   */
  followUps: v.optional(v.array(v.nullable(v.boolean()))),
  /**
   * Free-form organizational labels for the saved-pipeline library (filter/search).
   * Absent ⇒ no labels. Applies to built-in and custom pipelines alike.
   */
  labels: v.optional(v.array(v.string())),
  /**
   * When true the pipeline is archived: kept but hidden from the default library view
   * (a "show archived" toggle reveals it). Organizational only — an archived built-in
   * is still read-only for structure. Absent / false ⇒ active.
   */
  archived: v.optional(v.boolean()),
  /**
   * True for the curated built-in catalog pipelines (`seedPipelines()`). Built-ins
   * are read-only templates: they can be cloned (into an editable copy) but not
   * edited in place. Absent / false on user-created and cloned pipelines.
   */
  builtin: v.optional(v.boolean()),
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
  'rejected',
  // A companion agent could not return a parseable quality assessment (truncated /
  // malformed) even after a repair retry, so the run was failed for human attention.
  // (Exhausting the automatic rework budget no longer fails the run — it parks on the
  // companion iteration-cap gate for a human; see `companion.exceeded`.)
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
  /** The PR head commit being gated, once resolved. */
  headSha: v.optional(v.nullable(v.string())),
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
})
export type RunEnvironment = v.InferOutput<typeof runEnvironmentSchema>

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
   * Live state of a `human-test` gate (ephemeral env + human validation loop); see
   * {@link humanTestStepStateSchema}. Absent for every other step kind.
   */
  humanTest: v.optional(v.nullable(humanTestStepStateSchema)),
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
   * Internal user id (`usr_*`) of whoever started this run (or retried it). Recorded
   * so the individual-usage restricted mode can use the initiator's OWN personal
   * subscription (e.g. Claude) for the run's steps — a personal credential is never
   * shared, so only its owner's runs may use it. Absent for runs started without a
   * signed-in user (auth-disabled/local dev) and for legacy runs.
   */
  initiatedBy: v.optional(v.nullable(v.string())),
})
export type ExecutionInstance = v.InferOutput<typeof executionInstanceSchema>

export const workspaceSchema = v.object({
  id: v.string(),
  name: v.string(),
  /** Optional free-text description (null when unset). */
  description: v.nullable(v.string()),
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
