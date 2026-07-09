import type {
  AgentConfigValues,
  AgentKind,
  BlockType,
  CloudProvider,
  ConsensusStepConfig,
  EnvironmentAccessHandle,
  EnvironmentStatus,
  FrontendConfig,
  InstanceSize,
  PullRequestRef,
  PeerPullRequest,
  ReferenceRepo,
  ServiceProvisioning,
  StepSubtasks,
  TestSecretRef,
  StreamedFollowUp,
  TaskEstimate,
  TaskTypeFields,
  WebSearchAvailability,
} from '../domain/types.js'
import type { InitiativePresetPhaseTemplate } from '@cat-factory/contracts'

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
  /**
   * Monotonic per-step dispatch counter, folded into the harness job id so a step that is
   * RE-dispatched within one run (the Tester→Fixer loop's re-test, a fixer round, a polling
   * gate's helper attempt) never collides with — and so never RE-ATTACHES to — a prior
   * round's completed harness job. The harness keys its `JobRegistry` by the backend-supplied
   * job id and re-attaches to an existing entry rather than re-running (replay idempotency),
   * and a container-reusing transport (a warm local pool / a self-hosted runner pool) keeps
   * that registry alive across rounds because reclaiming a pooled member does NOT destroy it.
   * Without a per-round epoch the re-test would replay the first round's stale report. Derived
   * from the step's own round counter; absent/0 for a step dispatched once (the id is then
   * unsuffixed, so single-dispatch steps are unaffected).
   */
  dispatchEpoch?: number
  /** Whether this is the pipeline's last step (drives task finalisation). */
  isFinalStep: boolean
  /**
   * Whether the future-looking Follow-up companion is enabled for this step (a `coder`
   * step with the companion on). The container executor reads it to (a) append the
   * follow-up guidance to the Coder's system prompt and (b) set the harness job's
   * `streamFollowUps` so it tails the Coder's sentinel file. Absent/false ⇒ no streaming.
   */
  followUpCompanion?: boolean
  /**
   * Consensus configuration for this step, when it is consensus-enabled in the
   * pipeline (copied from the pipeline's `consensus` array onto the run's step).
   * Read ONLY by the optional consensus executor (`@cat-factory/consensus`), which
   * decides — possibly gated on `block.estimate` — whether to run the multi-model
   * process or delegate to the standard single-actor agent. Absent ⇒ standard agent.
   */
  consensus?: ConsensusStepConfig | null
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
    /**
     * The task's resolved BUSINESS-vs-TECHNICAL label, when determined. `true` ⇒ purely
     * TECHNICAL (a refactor / non-functional / internal change): the implementer treats the
     * task definition / incorporated requirements as the PRIMARY source of truth and the
     * committed specs as a regression-spotting reference, and the spec-writer may produce no
     * business specs. `false` ⇒ explicitly BUSINESS: the spec-writer MUST produce specs (it
     * is told not to claim "no business specs"). Set by the engine from the block's resolved
     * `technical` label (human-set or inferred from the spec phase); absent ⇒ not yet
     * determined (the normal spec-led behaviour).
     */
    technical?: boolean
    /** Id of the model picked for this block (overrides the agent routing), if any. */
    modelId?: string
    /**
     * Id of the model preset selected for this task, if any. When the block pins no
     * model directly, the step's model is resolved from this preset (`overrides[kind]
     * ?? baseModelId`); absent → the workspace default preset.
     */
    modelPresetId?: string
    /**
     * Requirements/RFC/PRD pages linked to this block from Confluence, supplied
     * as extra context. Present only when the Confluence integration is wired and
     * the block has linked documents.
     */
    contextDocs?: {
      title: string
      url: string
      /** Short plain-text excerpt for list/preview rendering. */
      excerpt: string
      /** One-line summary rendered into the in-prompt summary index. */
      summary: string
      /** Full normalized-Markdown body, materialised as a file for the agent to explore. */
      body: string
    }[]
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
      /** One-line summary rendered into the in-prompt summary index. */
      summary: string
    }[]
    /**
     * Task-level configuration values contributed by the agents in this task's
     * pipeline (a sparse id→value map; see the agent-config contracts). Folded
     * into the relevant agents' prompts and job bodies — e.g. the Playwright agent
     * reads `playwright.e2eTarget` (ci vs ephemeral). Absent when nothing is set.
     */
    agentConfig?: AgentConfigValues
    /**
     * A pull request already opened for this block (e.g. by an earlier `coder`
     * step in the same run). The Blueprinter step reads its `branch` so it commits
     * the regenerated blueprint onto the implementation's branch rather than a new
     * one. Absent until a step records a PR.
     */
    pullRequest?: PullRequestRef
    /**
     * PRs opened in CONNECTED services' repos during a multi-repo run (service-connections
     * phase 3), one per involved-service repo the coder changed — lifted verbatim from the
     * block. The `merger` reads these to score the COMBINED diff: it clones each peer PR's
     * repo as a read-only sibling at its PR branch and assesses the whole cross-repo change
     * together (phase 4). Absent for a single-repo task.
     */
    peerPullRequests?: PeerPullRequest[]
    /**
     * The task-estimator's triage of this block (complexity / risk / impact), when
     * a `task-estimator` step has run earlier in the pipeline. Read by the consensus
     * executor to gate the (expensive) multi-model process against the step's
     * configured thresholds. Absent until an estimate has been produced.
     */
    estimate?: TaskEstimate | null
    /**
     * The block's per-type creation fields (a bug's severity, a `document` task's
     * `docKind` / `audience` / `targetPath` / `outlineHints`, …). Threaded so a kind's
     * user-prompt builder can specialise on them — e.g. the document-authoring agents read
     * `docKind` to pick the right structure and `targetPath` to know where to write. Sparse;
     * absent when no per-type fields were collected.
     */
    taskTypeFields?: TaskTypeFields
    /**
     * The raw Markdown of the workspace's linked TEMPLATE document for this task's `docKind`
     * (WS1 item 3), resolved by the engine when a `role: 'template'` document is linked for the
     * kind. The doc-authoring prompts parse it into the kind's effective template (its sections
     * override the built-in skeleton), and the `doc-quality` gate checks against the same
     * sections — one source of truth. Absent ⇒ the built-in `docTemplateFor(kind)` skeleton.
     */
    docTemplateBody?: string
    /**
     * The workspace's linked EXEMPLAR documents for this task's `docKind` (WS1 item 4) — "good
     * examples to emulate" the author agents are pointed at, alongside the built-in curated
     * exemplars. Each carries a short excerpt (not the full body) so the reference stays cheap.
     * Absent ⇒ only the built-in exemplars (if any) are surfaced.
     */
    docExemplars?: { title: string; url: string; excerpt: string }[]
    /**
     * The synthesized authoring brief from the interactive document-interview session (WS5),
     * present when the `doc-interviewer` step ran and converged for this task. The doc-writer
     * folds it into its prompt as the refined spec to write from (in place of the raw outline).
     * Absent ⇒ no interview ran (or none converged); the writer uses the outline/description.
     */
    docInterviewBrief?: string
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
   * service frame. Carries the service-owned provisioning config (the "what + where":
   * the provision type + in-repo manifest/compose source the Tester's infra stand-up
   * and the deployer read), and the cloud provider + abstract instance size the
   * dispatch resolves to a concrete instance-type id. Absent when no service frame
   * applies.
   */
  service?: {
    /**
     * The service-owned provisioning config — the provision type it produces
     * (`kubernetes` / `docker-compose` / `custom` / `infraless`) plus the in-repo
     * specifics. The Tester reads the type to pick its run mode (compose stand-up for
     * `docker-compose`, the provisioned env URL for `kubernetes`/`custom`, nothing for
     * `infraless`); the deployer merges it with the workspace handler at provision time.
     */
    provisioning?: ServiceProvisioning
    cloudProvider?: CloudProvider
    instanceSize?: InstanceSize
  }
  /**
   * Frontend-frame configuration resolved by the engine when this run's frame is a
   * `type: 'frontend'` app (the self-contained UI-test flow). Carries the frame's
   * `config` (build/serve/mock knobs; the harness applies the defaults) and the frame's
   * backend bindings ALREADY RESOLVED to concrete upstreams: each surviving binding's
   * env var plus the bound service's live ephemeral env URL (the "service under test")
   * when one is live, else absent (the harness mocks it with WireMock). Empty-envVar
   * bindings are dropped here so an unfinished inspector row is never injected. Present
   * only for a `frontend` frame with a `frontendConfig`; the `testerInfraSpec` builder
   * turns it into the harness's `frontend` infra spec, and the tester-infra start gate
   * uses `bindings.some(b => b.serviceUrl)` (a live service under test) to admit the run.
   */
  frontend?: {
    config: FrontendConfig
    bindings: { envVar: string; serviceUrl?: string }[]
  }
  /**
   * The connected services "directly involved" in this task beyond its own (see the service
   * connections initiative) — resolved by the engine from the task's `involvedServiceIds`,
   * read-time stale-filtered to ids that still resolve to a connected service frame. Each carries
   * the frame's title, the connection `description` prose (folded into the agent prompt to explain
   * the relationship), and — when the involved service has a LIVE ephemeral env provisioned in
   * this run — its URL. The Tester turns these into its `peerEnvironments` infra map so a
   * cross-service integration test can reach the peer's real environment. Absent when the task
   * names no (still-valid) involved services.
   */
  involvedServices?: {
    frameId: string
    title: string
    description?: string
    envUrl?: string
  }[]
  /**
   * The SENSITIVE test credentials configured for this run's service frame — as non-secret
   * REFERENCES only (each key + its description), NEVER the values. Resolved by the engine
   * from the service-frame's sealed test-secret store; present only for the tester kinds (the
   * kinds that receive the values out-of-band). The tester prompt advertises these so the agent
   * knows which environment variables are available and what each is for; the VALUES are
   * decrypted at dispatch and injected into the container environment by the executor + harness,
   * never rendered into the prompt or the telemetry snapshot. Absent when the service has none.
   */
  testSecrets?: TestSecretRef[]
  /**
   * Read-only reference repositories attached to a document-authoring task (the doc-writer
   * agent) — lifted verbatim by the engine from the task block's `referenceRepos`. The
   * executor turns these into read-only sibling checkouts the agent may read but never write
   * to. Each carries its own provider-neutral clone identity (repoId/owner/name/defaultBranch/
   * connectionId), so a repo outside the workspace's synced projection can still be cloned.
   * Absent for non-doc tasks or a task with none attached.
   */
  referenceRepos?: ReferenceRepo[]
  /**
   * For a `conflict-resolver` the conflicts gate dispatched on a PEER-repo conflict
   * (a multi-repo, service-connections task), which of the block's repos the resolver
   * must target — set by the engine from the gate's `step.gate.conflictTarget` when the
   * conflict is on a connected involved service's repo (`frameId` present). The container
   * executor resolves THAT frame's repo (not the task's own service) and clones its PR
   * (work) branch. Absent ⇒ the own-service repo (the single-repo default). Only the
   * conflict-resolver reads it; every other kind ignores it.
   */
  conflictTarget?: { repo: string; frameId: string }
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
  /**
   * The initiative context a run carries, resolved by the engine from the block's `initiatives`
   * entity. Two shapes:
   *  - An initiative-LEVEL (planning) run carries the FULL planning context: the interviewer's
   *    synthesized goal / constraints / non-goals + the Q&A digest, plus the analyst's codebase
   *    analysis — so the analyst and planner prompts are grounded in the human's intent and the
   *    prior step's findings.
   *  - A run SPAWNED by an initiative (a task/module/frame carrying `block.initiativeId`) carries
   *    a PRESET-ONLY context — just `preset` (label + the per-kind `promptAddition`) — so the org's
   *    standing methodology reaches the child coder / tester / custom kind (D1). No goal/qa/analysis
   *    is folded onto a spawned run: the item description is the child's task contract.
   * Absent when no initiative entity is wired, the block is neither initiative-level nor
   * initiative-spawned, or (spawned) the preset contributes no addition for the running kind.
   */
  initiative?: {
    goal?: string
    constraints?: string[]
    nonGoals?: string[]
    qa?: { question: string; answer: string }[]
    analysisSummary?: string
    /**
     * The initiative PRESET's planning steering for THIS step, resolved by the engine from the
     * entity's `presetId` against the registry. `label` names the preset; `promptAddition` is its
     * per-agent-kind steering text (already resolved for the running kind); `phaseTemplate` is the
     * preset's declarative plan shape (slice T1), which the planner prompt fold renders as a
     * "required plan shape" section. Present ONLY when the preset contributes at least one of these
     * for the running kind — the built-in generic preset registers neither, so this stays absent
     * and the generic planning prompt is byte-for-byte today's. (The frozen form is surfaced via
     * `qa`, not here.)
     */
    preset?: {
      label: string
      promptAddition?: string
      phaseTemplate?: InitiativePresetPhaseTemplate
    }
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
   * PRs the container "implementer" opened in CONNECTED services' repos during a multi-repo
   * run (service-connections phase 3) — one per involved-service repo it actually changed,
   * attributed to the repo (`owner/name`) and its involved service frame. The own-service PR
   * stays on {@link pullRequest}; the engine records these on the block's `peerPullRequests`
   * beside it. Absent for a single-repo run.
   */
  peerPullRequests?: PeerPullRequest[]
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
   * Set by a `spec-writer` step when the task is purely TECHNICAL (a refactor /
   * non-functional / internal change that introduces no externally-observable
   * behaviour) so there are NO business requirements to specify. "No new specs" is a
   * valid outcome: the writer leaves the baseline spec untouched (no `spec` channel,
   * so `specPostOp` commits nothing) and the engine reads this flag — together with
   * the spec-companion's corroboration — to infer the block's `technical` label.
   */
  noBusinessSpecs?: boolean
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
   * A `tester` step's in-container docker-compose dependency stand-up record (explore mode,
   * local infra): whether the dependencies came up and the captured (redacted, bounded)
   * `docker compose up` logs. The engine persists it on the Tester step so the test window
   * can surface WHY local infra failed to come up — the failure-class artifact the
   * orchestrator-side provisioning logs can't capture (the stand-up runs inside the
   * container). Carried as `unknown` so the port stays free of the contracts schema; the
   * engine parses it before use. Absent for ephemeral / no-infra runs.
   */
  infraSetup?: unknown
  /**
   * An `on-call` step's structured release-regression assessment (culprit confidence,
   * recommendation, rationale, evidence). The post-release-health gate dispatched the
   * agent on a Datadog regression; the engine validates this, raises a
   * `release_regression` notification and enriches any open incident. Carried as
   * `unknown` so the port stays free of the contracts schema; the engine parses it.
   */
  onCallAssessment?: unknown
  /**
   * The multi-phase initiative plan draft an `initiative-planner` step produced
   * (phases, items with estimates + dependencies, the execution policy). The engine
   * strictly validates it and ingests it into the block's `initiatives` entity;
   * the committer step later renders + commits the in-repo tracker from that
   * entity. Carried as `unknown` so the port stays free of the contracts schema;
   * the engine parses it before use.
   */
  initiativePlan?: unknown
  /**
   * A generic, manifest-driven `agent` step's structured output (the parsed JSON object
   * a `container-explore` structured agent returned). Carried as `unknown` so the port
   * stays free of any schema; the kind's post-op coerces/validates + renders artifact
   * files from it. The well-known channels above (`blueprintService`/`spec`/…) remain for
   * the bespoke built-in kinds during migration; `custom` is the channel a custom or
   * manifest-driven structured agent uses.
   */
  custom?: unknown
  /**
   * Tokens the model consumed for this call. Reported by inline LLM executors so
   * the spend safeguard can meter usage; absent for the PROXY-metered container path
   * (Pi, whose proxy meters tokens itself to avoid double-counting) and test fakes.
   * ALSO reported by the container executor for a SUBSCRIPTION harness run (Claude
   * Code / Codex, which bypass the proxy) — those are tagged {@link usageBilling}
   * `'subscription'` so the engine records them for the usage report while the budget
   * gate excludes them.
   */
  usage?: AgentTokenUsage
  /**
   * How {@link usage} should be metered: `'metered'` (a real per-token cost, summed by
   * the budget gate — the default for inline executors) or `'subscription'` (a flat-rate
   * quota harness call, counted for the usage report but excluded from every spend
   * rollup). Only meaningful when `usage` is present. Absent ⇒ `'metered'`.
   */
  usageBilling?: 'metered' | 'subscription'
  /**
   * The subscription vendor (claude/codex/glm/kimi/deepseek) for a `'subscription'`
   * {@link usageBilling} row, so the usage report can break usage down by vendor. Absent
   * for metered usage.
   */
  usageVendor?: string
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
   * The run initiator's user id, carried so the poll site can attribute a PERSONAL
   * (individual-usage) subscription run's quota usage to the right user — the personal
   * path leases no pooled token, so {@link subscriptionTokenId} is absent for it. Set by
   * the executor at dispatch; absent for runs with no known initiator (system paths).
   */
  initiatedByUserId?: string
  /**
   * The model provider/vendor the job runs on (e.g. `claude`, `codex`, `openai`),
   * known at dispatch. Carried so the poll site can stamp it on the per-call telemetry
   * a subscription harness reports (which the proxy would otherwise supply). Absent ⇒
   * telemetry falls back to the provider parsed from {@link model}.
   */
  provider?: string
  /**
   * The agent kind the job runs as (`coder`, `merger`, …). The poll site MUST supply it
   * for any kind whose result is mapped kind-aware (e.g. a migrated `merger`/`on-call`,
   * whose structured output is coerced into `mergeAssessment`/`onCallAssessment`); without
   * it that coercion silently no-ops and the engine's gate sees no assessment. Also used to
   * label the job's tool spans on the observability trace. Optional only because not every
   * executor needs it — absent ⇒ no kind-aware mapping + spans grouped under the run unlabelled.
   */
  agentKind?: string
  /**
   * Whether web search was available to this job's container and which upstream backend
   * served it, resolved backend-side at dispatch (the run's account web-search keys, else
   * the deployment default). Recorded on the step immediately so the run details surface
   * "Web search: SearXNG" / "unavailable" without waiting for a poll. Absent for executors
   * that don't resolve search availability (inline agents, tests).
   */
  search?: WebSearchAvailability
  /**
   * The repo this job operates on, resolved at dispatch. Recorded in the run's diagnostics so a
   * later investigation knows which repo/branch the step ran against without re-joining the
   * service↔repo↔installation projection. `provider` is the VCS provider (`github`/`gitlab`) from
   * the run's repo origin. Absent for executors that don't operate on a repo (inline agents, tests).
   */
  repo?: { owner: string; name: string; baseBranch?: string; provider?: string }
}

/** The outcome of polling an {@link AgentJobHandle}. */
export type AgentJobUpdate =
  /**
   * Still working — the durable driver should keep polling. `subtasks`, when
   * present, carries the job's latest subtask counts (the container agent reads
   * these from the coding tool's todo list) so the driver can surface live
   * "N/M done" progress on the step between polls. `followUps`, when present,
   * carries the forward-looking items the Coder streamed since the last poll
   * (drain-on-read) so the engine can append them to the run's step live (the
   * Follow-up companion). `phase` carries the container's current lifecycle phase
   * (clone / agent / push) and `container` its identity/address (id, url) once up,
   * so the engine can surface what the container is doing + where it's running.
   */
  | {
      state: 'running'
      subtasks?: StepSubtasks
      followUps?: StreamedFollowUp[]
      phase?: string
      container?: { id?: string; url?: string }
      /** Which runner backend served this job (see {@link RunnerJobView.backend}); recorded in
       *  the run diagnostics on the first poll that reports it. */
      backend?: string
    }
  /**
   * Finished successfully; `result` carries the work product. `followUps`, when present,
   * carries any final burst of streamed items the harness drained on the SAME poll that
   * observed completion (the tailer is flushed before the job is marked done), so the
   * engine never loses the last items — notably a question that must hold the gate.
   */
  | { state: 'done'; result: AgentRunResult; followUps?: StreamedFollowUp[] }
  /**
   * Finished with a failure (agent error, inactivity/max-duration watchdog, …). When the
   * harness reported a STRUCTURED `failureCause`, it is forwarded here so the driver can
   * classify the failure (→ `AgentFailureKind`) without regex-matching `error`; absent on an
   * older harness image (the driver falls back to the error-string regex). `detail` carries an
   * extended, redacted diagnostic (phase timings, last-tool breadcrumb) distinct from the
   * one-line `error`, surfaced as the failure detail on the board.
   */
  | { state: 'failed'; error: string; failureCause?: string; detail?: string; backend?: string }

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
