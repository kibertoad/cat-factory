import * as v from 'valibot'
import {
  agentKindSchema,
  agentStateSchema,
  blockLevelSchema,
  blockStatusSchema,
  blockTypeSchema,
  positionSchema,
  testTargetSchema,
} from './primitives'

// ---------------------------------------------------------------------------
// Entity schemas: the single source of truth for the data shapes that travel
// over the wire. Domain types in @cat-factory/core are derived from these, and
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
  status: blockStatusSchema,
  progress: v.number(),
  dependsOn: v.array(v.string()),
  executionId: v.nullable(v.string()),
  level: blockLevelSchema,
  parentId: v.nullable(v.string()),
  confidence: v.optional(v.number()),
  confidenceThreshold: v.optional(v.number()),
  moduleName: v.optional(v.string()),
  features: v.optional(v.array(v.string())),
  /**
   * Ids of curated best-practice prompt fragments selected for this block. Their
   * bodies are composed into the agent system prompt at run time. The catalog
   * itself lives in @cat-factory/prompt-fragments and is served separately.
   */
  fragmentIds: v.optional(v.array(v.string())),
  /**
   * Id of the LLM model selected for this block from the shared model catalog
   * (see MODEL_CATALOG in @cat-factory/core). When set it overrides the agent
   * routing's default model at run time; absent means "use the routing default".
   */
  modelId: v.optional(v.string()),
  /**
   * Where this block's acceptance / Playwright tests run — in project CI via
   * GitHub Actions, or against the provisioned ephemeral environment. Drives the
   * acceptance-testing agents' prompt. Absent means no preference recorded.
   */
  testTarget: v.optional(testTargetSchema),
  /**
   * The pull request the block's implementation ("implementer") agent opened for
   * its work. Set on a task once its container agent pushes a branch and opens a
   * PR; surfaced on the board so the PR can be opened from the selected task.
   */
  pullRequest: v.optional(pullRequestRefSchema),
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
})
export type PromptFragment = v.InferOutput<typeof promptFragmentSchema>

/** The full catalog as served by `GET /prompt-fragments`. */
export const promptFragmentCatalogSchema = v.array(promptFragmentSchema)
export type PromptFragmentCatalog = v.InferOutput<typeof promptFragmentCatalogSchema>

/**
 * A selectable LLM model, resolved to the flavour actually in use for this
 * deployment (`GET /models`). `flavor` is `direct` when the model's own provider
 * API key is configured, else `cloudflare`. `provider`/`model` are the effective
 * {@link ModelRef} parts the agent will run with; the picker stores only `id`.
 */
export const modelOptionSchema = v.object({
  /** Stable id persisted on a block (`Block.modelId`). */
  id: v.string(),
  /** Model-family label, e.g. `Qwen3`. */
  label: v.string(),
  /** One-line description shown in the picker. */
  description: v.string(),
  /** Which flavour is active for this deployment. */
  flavor: v.picklist(['cloudflare', 'direct']),
  /** Short provider label for the active flavour, e.g. `Cloudflare`, `DashScope`. */
  providerLabel: v.string(),
  /** Effective provider id the agent runs with. */
  provider: v.string(),
  /** Effective model id within the provider. */
  model: v.string(),
})
export type ModelOption = v.InferOutput<typeof modelOptionSchema>

/** The full catalog as served by `GET /models`. */
export const modelCatalogSchema = v.array(modelOptionSchema)
export type ModelCatalog = v.InferOutput<typeof modelCatalogSchema>

export const pipelineSchema = v.object({
  id: v.string(),
  name: v.string(),
  agentKinds: v.array(agentKindSchema),
})
export type Pipeline = v.InferOutput<typeof pipelineSchema>

export const decisionSchema = v.object({
  id: v.string(),
  question: v.string(),
  options: v.array(v.string()),
  chosen: v.nullable(v.string()),
})
export type Decision = v.InferOutput<typeof decisionSchema>

/**
 * Live subtask counts for a running step, reported by the container agent from
 * the coding tool's own todo list (e.g. "3/8 done, 1 in progress"). Present only
 * while an async job is in flight and the agent maintains a todo list; the board
 * renders it as a finer-grained progress indicator than `progress` alone.
 */
export const stepSubtasksSchema = v.object({
  completed: v.number(),
  inProgress: v.number(),
  total: v.number(),
})
export type StepSubtasks = v.InferOutput<typeof stepSubtasksSchema>

export const pipelineStepSchema = v.object({
  agentKind: agentKindSchema,
  state: agentStateSchema,
  progress: v.number(),
  /** Live subtask counts while an async (container) step runs; see {@link stepSubtasksSchema}. */
  subtasks: v.optional(stepSubtasksSchema),
  decision: v.nullable(decisionSchema),
  /** Text the agent produced for this step (when LLM execution is enabled). */
  output: v.optional(v.string()),
  /** Identifier of the model that produced `output`, for transparency. */
  model: v.optional(v.string()),
  /**
   * Identifier of an in-flight asynchronous agent job (a container run polled by
   * the durable driver). Set while the step is dispatched-but-not-yet-finished so
   * a Workflows replay re-attaches to the running job instead of starting a new
   * one; cleared once the job's result is recorded.
   */
  jobId: v.optional(v.string()),
})
export type PipelineStep = v.InferOutput<typeof pipelineStepSchema>

export const executionStatusSchema = v.picklist(['running', 'blocked', 'done', 'paused'])
export type ExecutionStatus = v.InferOutput<typeof executionStatusSchema>

export const executionInstanceSchema = v.object({
  id: v.string(),
  blockId: v.string(),
  pipelineId: v.string(),
  pipelineName: v.string(),
  steps: v.array(pipelineStepSchema),
  currentStep: v.number(),
  status: executionStatusSchema,
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

export const workspaceSnapshotSchema = v.object({
  workspace: workspaceSchema,
  blocks: v.array(blockSchema),
  pipelines: v.array(pipelineSchema),
  executions: v.array(executionInstanceSchema),
  /**
   * The current spend-safeguard status. Attached by the worker (it depends on
   * deployment-wide pricing/budget config), so it is optional on the wire.
   */
  spend: v.optional(spendStatusSchema),
})
export type WorkspaceSnapshot = v.InferOutput<typeof workspaceSnapshotSchema>
