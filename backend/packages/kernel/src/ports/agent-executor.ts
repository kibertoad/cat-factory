import type {
  AgentConfigValues,
  AgentKind,
  BlockType,
  CloudProvider,
  EnvironmentAccessHandle,
  EnvironmentStatus,
  InstanceSize,
  PullRequestRef,
  StepSubtasks,
} from '../domain/types.js'

// Port for "an agent doing its work". The execution engine calls this to perform
// each pipeline step. An agent either produces a work product or asks for a
// human decision before it can finish. Concrete implementations:
//   - AiAgentExecutor         — real work via an LLM (Vercel AI SDK)
//   - ContainerAgentExecutor  — repo-operating steps in a per-run sandbox container
//   - a test fake             — deterministic, used by the integration tests
// Modelling the work as a port keeps the engine free of LLM/infra concerns and
// lets the integration tests drive it with a deterministic fake.

export interface AgentRunContext {
  agentKind: AgentKind
  pipelineName: string
  /**
   * The workspace and execution the step belongs to. The engine always sets
   * these; they are optional on the type so existing fakes that hand-build a
   * context stay valid. Executors that reach beyond the LLM — e.g. the container
   * executor that clones the workspace's repo and meters spend through a proxy —
   * require them and fail fast when absent.
   */
  workspaceId?: string
  executionId?: string
  /**
   * Internal user id (`usr_*`) of whoever started/retried this run. Set by the engine
   * from the run's `initiatedBy`. The container executor uses it to lease the
   * initiator's OWN personal (individual-usage) subscription — e.g. Claude — for the
   * step, since such a credential is never shared. Absent for runs started without a
   * signed-in user.
   */
  initiatedByUserId?: string
  /** Index of this step within the pipeline. */
  stepIndex: number
  /** Whether this is the pipeline's last step (drives task finalisation). */
  isFinalStep: boolean
  block: {
    /** Stable block id (set by the engine; used by repo-aware executors). */
    id?: string
    title: string
    type: BlockType
    description: string
    /** Ids of selected best-practice fragments to fold into the system prompt. */
    fragmentIds?: string[]
    /**
     * Fragment bodies the engine pre-resolved from the tenant fragment-library
     * (the merged catalog + relevance selection; ADR 0006). When present these
     * are folded into the system prompt verbatim, superseding `fragmentIds`'
     * static resolution. Absent when the library module is not configured.
     */
    resolvedFragments?: { id: string; body: string }[]
    /** Id of the model picked for this block (overrides the agent routing), if any. */
    modelId?: string
    /**
     * Requirements/RFC/PRD pages linked to this block from Confluence, supplied
     * as extra context. Present only when the Confluence integration is wired and
     * the block has linked documents.
     */
    contextDocs?: { title: string; url: string; excerpt: string }[]
    /**
     * Tracker issues (Jira, …) linked to this block, supplied as extra context.
     * Present only when the task-source integration is wired and the block has
     * linked issues. Carries the structured fields so the prompt can render a
     * status/assignee header alongside the description and recent comments.
     */
    contextTasks?: {
      key: string
      url: string
      title: string
      status: string
      type: string
      assignee: string | null
      priority: string | null
      labels: string[]
      description: string
      comments: { author: string; createdAt: string; body: string }[]
    }[]
    /**
     * Task-level configuration values contributed by the agents in this task's
     * pipeline (a sparse id→value map; see the agent-config contracts). Folded
     * into the relevant agents' prompts and job bodies — e.g. the Tester reads
     * `tester.environment` (local vs ephemeral) and the Playwright agent reads
     * `playwright.e2eTarget` (ci vs ephemeral). Absent when nothing is set.
     */
    agentConfig?: AgentConfigValues
    /**
     * A pull request already opened for this block (e.g. by an earlier `coder`
     * step in the same run). The Blueprinter step reads its `branch` so it commits
     * the regenerated blueprint onto the implementation's branch rather than a new
     * one. Absent until a step records a PR.
     */
    pullRequest?: PullRequestRef
  }
  /** Outputs produced by earlier steps in the same run, in order. */
  priorOutputs: { agentKind: AgentKind; output: string }[]
  /** Decisions resolved earlier in this run, for context. */
  decisions: { question: string; chosen: string }[]
  /**
   * A live ephemeral environment a deployer step provisioned earlier in this run
   * (resolved from the run's block). Present only when the environment
   * integration is wired and a deployer step has produced a ready environment —
   * this is how a downstream tester agent discovers the URL and how to reach it.
   */
  environment?: {
    url: string | null
    status: EnvironmentStatus
    access: EnvironmentAccessHandle | null
    expiresAt: number | null
  }
  /**
   * Service-level (frame) configuration resolved by the engine from this run's
   * service frame. Carries what the Tester's local-infra path and the
   * provisioning layer need: the docker-compose path to stand up dependencies (or
   * the explicit "no infra" flag), and the cloud provider + abstract instance size
   * the dispatch resolves to a concrete instance-type id. Absent when no service
   * frame applies.
   */
  service?: {
    testComposePath?: string
    noInfraDependencies?: boolean
    cloudProvider?: CloudProvider
    instanceSize?: InstanceSize
  }
  /**
   * If this step previously raised a decision that a human has now resolved,
   * the resolved decision — so the agent can finish instead of re-raising it.
   */
  resolvedDecision: { question: string; chosen: string } | null
  /**
   * When a human reviewed this step's gated proposal and requested changes, the
   * previous proposal plus their feedback. Present only on a re-run triggered by
   * "Request changes"; the agent should revise its previous proposal to address
   * the feedback rather than start from scratch. `comments` are GitHub-review-style
   * notes on specific blocks of the proposal (a human review carries the verbatim
   * `quotedSource` it targets; a companion's anchor-based comment omits it), folded
   * into the prompt alongside the freeform `feedback`.
   */
  revision?: {
    previousProposal: string
    feedback: string
    comments?: { quotedSource?: string; body: string }[]
  }
}

/** A point at which the agent needs a human to choose before continuing. */
export interface AgentDecisionRequest {
  question: string
  options: string[]
}

/** Token usage reported by the model for a single agent call. */
export interface AgentTokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface AgentRunResult {
  /** The agent's work product. Required unless `decision` is set. */
  output?: string
  /** Identifier of the model that produced the output, for transparency. */
  model?: string
  /** Ask a human to decide before this step can complete. */
  decision?: AgentDecisionRequest
  /** Confidence in the result (0..1); used at task completion to auto-merge. */
  confidence?: number
  /**
   * A pull request the agent opened for its work. Reported by repo-operating
   * executors (the container "implementer" agent, which pushes a branch and opens
   * a PR); the engine records it on the block so the board can link to it.
   */
  pullRequest?: PullRequestRef
  /**
   * The service → modules blueprint tree a Blueprinter step produced.
   * The engine strictly validates it and reconciles it onto the board (in place).
   * Carried as `unknown` so the core port stays free of the contracts schema; the
   * engine parses it with the authoritative Valibot schema before use.
   */
  blueprintService?: unknown
  /**
   * The unified, prescriptive specification doc a `spec-writer` step produced and
   * committed to the implementation branch (the `spec.json` tree). The engine
   * strictly validates it (against the contracts schema) and may surface it on the
   * board. Carried as `unknown` so the core port stays free of the contracts schema;
   * the engine parses it before use.
   */
  spec?: unknown
  /**
   * A `merger` step's structured PR assessment (complexity / risk / impact +
   * rationale). The engine validates it, compares the scores against the task's
   * resolved merge preset, and either performs a real GitHub merge or raises a
   * `merge_review` notification. Carried as `unknown` so the port stays free of
   * the contracts schema; the engine parses it before use.
   */
  mergeAssessment?: unknown
  /**
   * A `tester` step's structured test report (what was exercised, the per-area
   * outcomes, any concerns/bugs, and the greenlight verdict). The engine validates
   * it and, when the Tester withholds its greenlight, dispatches the `fixer` agent
   * and re-tests — looping until greenlight or the attempt budget is spent. Carried
   * as `unknown` so the port stays free of the contracts schema; the engine parses
   * it before use.
   */
  testReport?: unknown
  /**
   * Tokens the model consumed for this call. Reported by inline LLM executors so
   * the spend safeguard can meter usage; absent for the container executor (whose
   * proxy meters tokens itself, to avoid double-counting) and test fakes.
   */
  usage?: AgentTokenUsage
}

export interface AgentExecutor {
  run(context: AgentRunContext): Promise<AgentRunResult>
  /**
   * Resolve the concrete model this step will run (`provider:model`) WITHOUT doing
   * the work — no LLM call, no container dispatch. The engine calls it up front so a
   * step's model can be surfaced to the board the moment the step starts (during the
   * inline LLM query, or the container cold-boot window) rather than only once the
   * result/job handle lands. Must be cheap and side-effect-free (model-ref resolution
   * only). Optional: an executor that can't cheaply preview omits it, and the engine
   * simply records the model later. Returns undefined when no model applies.
   */
  resolveModel?(context: AgentRunContext): Promise<string | undefined>
  /**
   * Whether this step will run on a flat-rate subscription (quota) model — i.e. a
   * Claude Code / Codex harness authenticated with a pooled subscription token. Such
   * runs incur NO metered monetary LLM cost (their usage is folded into a quota, not
   * the spend budget), so the engine's spend gate lets them proceed even when the
   * monetary budget is exhausted. Must be cheap and side-effect-free (model-ref
   * resolution only). Optional: an executor without subscription harnesses omits it
   * and the engine treats every step as budget-metered (the prior behaviour).
   */
  isQuotaBased?(context: AgentRunContext): Promise<boolean>
}

/** A handle to an asynchronous agent job (e.g. a long-running container run). */
export interface AgentJobHandle {
  /** Opaque identifier the executor uses to address the running job when polled. */
  jobId: string
  /**
   * The run (execution) the job belongs to. A run executes a sequence of jobs (one
   * per pipeline step) that share one per-run container, so the poll/stop site needs
   * the run id — alongside the per-step {@link jobId} — to address that container
   * (and to reclaim it). Set by the executor at dispatch and re-supplied by the
   * engine at the poll/stop site (it always has the execution id in scope). Absent ⇒
   * the job IS its own run (a single-job flow), so callers fall back to {@link jobId}.
   */
  runId?: string
  /**
   * The model the job runs (`provider:model`), known at dispatch. Recorded on the
   * step immediately so the board shows it even though the poll site — which maps
   * the eventual result — has no access to the resolved model ref.
   */
  model?: string
  /**
   * The workspace the job belongs to. The engine sets this at the poll site (it is
   * in scope there) so an executor that picks a per-workspace backend — e.g. the
   * container executor choosing a self-hosted runner pool over Cloudflare
   * Containers — can resolve the same backend when polling, given only the job id.
   */
  workspaceId?: string
  /**
   * For a subscription-harness job, the id of the pooled token leased for it, so
   * the poll site can attribute the run's usage back to the right pool row
   * (usage-aware rotation). Absent for proxy-metered Pi jobs.
   */
  subscriptionTokenId?: string
  /**
   * The agent kind the job runs as (`coder`, `merger`, …). Carried so the poll site
   * can label the job's tool spans when forwarding them to the observability trace
   * sink. Optional — absent ⇒ spans are still grouped under the run, just unlabelled.
   */
  agentKind?: string
}

/** The outcome of polling an {@link AgentJobHandle}. */
export type AgentJobUpdate =
  /**
   * Still working — the durable driver should keep polling. `subtasks`, when
   * present, carries the job's latest subtask counts (the container agent reads
   * these from the coding tool's todo list) so the driver can surface live
   * "N/M done" progress on the step between polls.
   */
  | { state: 'running'; subtasks?: StepSubtasks }
  /** Finished successfully; `result` carries the work product. */
  | { state: 'done'; result: AgentRunResult }
  /** Finished with a failure (agent error, inactivity/max-duration watchdog, …). */
  | { state: 'failed'; error: string }

/**
 * An executor whose work can outlive a single request. Instead of `run()`
 * blocking until the work finishes — which would cap the work at one durable
 * step's timeout — the driver {@link startJob}s it and then {@link pollJob}s for
 * completion between durable sleeps. This lets a long coding job run for many
 * minutes while every individual driver step stays short and cheaply retriable.
 *
 * Implemented by the container executor (whose Pi coding run can take a long
 * time); inline LLM executors stay plain {@link AgentExecutor}s and run in one
 * shot. `run()` remains available (it dispatches then polls internally) for
 * non-durable callers and tests.
 */
export interface AsyncAgentExecutor extends AgentExecutor {
  /** Whether `context` should be driven as a polled job rather than run inline. */
  runsAsync(context: AgentRunContext): boolean
  /**
   * Start the job for `context`, or re-attach to one already running for it. Must
   * be idempotent per execution so a replayed dispatch never starts a duplicate.
   */
  startJob(context: AgentRunContext): Promise<AgentJobHandle>
  /** Poll a previously-started job for its current state. */
  pollJob(handle: AgentJobHandle): Promise<AgentJobUpdate>
  /**
   * Best-effort: stop a running job and reclaim its backing resources (e.g. kill
   * the per-run container), so a user cancel / block delete / orphan sweep does not
   * leak a container that idles until its watchdog. Optional — backends with
   * nothing to reclaim may omit it; callers must treat it as best-effort and must
   * not let a failure here derail their own teardown. Idempotent: stopping an
   * already-gone job is a no-op.
   */
  stopJob?(handle: AgentJobHandle): Promise<void>
}

/** Narrow an executor to the async-capable interface. */
export function isAsyncAgentExecutor(executor: AgentExecutor): executor is AsyncAgentExecutor {
  const candidate = executor as Partial<AsyncAgentExecutor>
  return (
    typeof candidate.runsAsync === 'function' &&
    typeof candidate.startJob === 'function' &&
    typeof candidate.pollJob === 'function'
  )
}
