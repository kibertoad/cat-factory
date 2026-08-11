import type {
  AgentConfigValues,
  AgentKind,
  BlockType,
  CloudProvider,
  ConsensusStepConfig,
  DesignImageSet,
  DocumentOrigin,
  EnvironmentAccessHandle,
  EnvironmentStatus,
  FrontendConfig,
  InjectedContextFile,
  InstanceSize,
  ModelFlavor,
  PullRequestRef,
  PeerPullRequest,
  ReferenceRepo,
  ReferenceScreenshotSet,
  AprioriBranch,
  ServiceProvisioning,
  StepSubtasks,
  TestSecretRef,
  StreamedFollowUp,
  TaskEstimate,
  TaskTypeFields,
  WebSearchAvailability,
} from '../domain/types.js'
import type { LocalModelDeclarations } from '../domain/local-model-declarations.js'
import type {
  ResolvedSkill,
  ResolvedToolServer,
  UnavailableToolServer,
} from '../domain/agent-capabilities.js'
import type { ResolvedBinaryGenerator } from '../domain/binary-generators.js'
import type { DesignImageDelivery } from '../domain/design-image-delivery.js'
import type { DocumentFreshness } from '../domain/document-freshness.js'
import type { OwnServiceContext } from '../domain/block-tree.js'
import type { CustomTaskTypeContext } from '../domain/task-type-context.js'
import type { ContainerEvictionKind } from './runner-transport.js'
import type { HarnessFailureCause } from '../domain/harness-failure.js'
import type {
  AgentEffortReport,
  DispatchToolServers,
  InitiativePresetPhaseTemplate,
} from '@cat-factory/contracts'

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
   * The base system prompt this dispatch runs instead of the kind's SHIPPED track prompt. Two
   * tiers arrive through this ONE field, already folded together: the workspace's own edited
   * prompt for the kind (from the pipeline builder) and the deployment-registered agent-kind
   * VARIANT the step selected (`stepOptions.agentVariantId` — an alternate prompt for an existing
   * kind, see `applyAgentVariant`). The workspace wins where both replace the prompt, being the
   * narrower tier; a variant's `promptAddition` then folds on top of whatever survived.
   *
   * Either way the engine-enforced surface directives and trait guidance are still layered on top
   * by `systemPromptFor`, so neither tier can delete the read-only guardrail or the
   * answer-in-the-reply rule.
   *
   * Resolved ONCE per dispatch by the engine (`AgentContextBuilder`) rather than by each
   * executor, so the container, inline and consensus paths cannot disagree about which prompt
   * a step ran under — and so a step's telemetry records the prompt that was actually sent. No
   * executor branches on which tier produced the text, which is the point of folding both here.
   * Absent ⇒ the kind's shipped prompt.
   */
  systemPromptOverride?: string
  /**
   * The output-token ceiling this dispatch runs under, when a workspace or the pipeline step
   * configured one. Overrides the deployment routing default (`AgentModelConfig.maxOutputTokens`);
   * absent ⇒ that default stands.
   *
   * Resolved ONCE per dispatch by the engine (`AgentContextBuilder`), for the same reason as
   * {@link systemPromptOverride}: the narrowest-tier-wins precedence (step option > workspace
   * setting > deployment routing) is decided in one place, so the container, inline and consensus
   * paths cannot disagree about the budget a step ran under.
   *
   * Only bites where the cap is genuinely ENFORCED — the metered provider path. The one-shot
   * subscription CLIs treat it as advisory (see the harness's `InlineJob.maxOutputTokens`), so a
   * value set here neither raises nor constrains an ambient `claude`/`codex` inline run.
   */
  maxOutputTokens?: number
  /**
   * The order this dispatch prefers a model's ROUTES in, from the model preset in force
   * (`ModelPreset.providerPreference`): a compliance preset can put AWS Bedrock ahead of a
   * model's own provider API, an everyday preset can put a flat-rate subscription first.
   * Absent ⇒ the deployment's default order (`DEFAULT_PROVIDER_PREFERENCE`).
   *
   * Resolved ONCE per dispatch by the engine (`AgentContextBuilder`), for the same reason as
   * {@link systemPromptOverride} and {@link maxOutputTokens}: the container, inline and consensus
   * paths must not disagree about which route a step ran on, and the run's telemetry records the
   * route that was actually used. It REORDERS and never filters, so a model whose only route the
   * preset omitted still resolves — see kernel's `orderedProviderPreference`.
   */
  providerPreference?: readonly ModelFlavor[]
  /**
   * What the RUN INITIATOR declared about the locally-run models they enabled (Ollama / LM Studio
   * / …), folded onto the resolved ref by `resolveStepModelRef`.
   *
   * Resolved ONCE per dispatch by the engine (`AgentContextBuilder`), for the same reason as
   * {@link providerPreference}, but for a second reason too, and it is the load-bearing one: a
   * local model has NO catalog entry, so the per-flavour facts every other model's ref carries have
   * nowhere else to come from, and the boot-time `resolveBlockModel` closure has no user in hand to
   * read them for. Absent (a system run, a deployment with no local runners) ⇒ every local ref
   * stays undeclared, which reads as `unknown_model_image_input` rather than as a text-only model.
   */
  localModelDeclarations?: readonly LocalModelDeclarations[]
  /**
   * Consensus configuration for this step, when it is consensus-enabled in the
   * pipeline (copied from the pipeline's `consensus` array onto the run's step).
   * Read ONLY by the optional consensus executor (`@cat-factory/consensus`), which
   * decides — possibly gated on `block.estimate` — whether to run the multi-model
   * process or delegate to the standard single-actor agent. Absent ⇒ standard agent.
   */
  consensus?: ConsensusStepConfig | null
  /**
   * The implementation approach a human chose in the optional fork-decision phase on the
   * Coder step, folded into the Coder's prompt as a binding directive. Set by the engine
   * from the step's `forkDecision.chosen` when dispatching the step's OWN coder kind (never
   * on a helper dispatch like the proposer, and absent when the phase was skipped / a
   * single path / not configured). `source` distinguishes a picked proposed fork from the
   * human's own free-text approach; `alternativesConsidered` lists the titles of the
   * rejected proposed forks so the Coder does not drift back into them.
   */
  implementationChoice?: {
    source: 'proposed' | 'custom'
    title: string
    approach: string
    note?: string
    /** Titles of the rejected alternatives, so the coder doesn't drift into them. */
    alternativesConsidered: string[]
  }
  /**
   * Ralph-loop iteration parameters, set by the engine when dispatching a `ralph` step from
   * its `step.ralph` state: the programmatic completion COMMAND the harness runs against the
   * checkout AFTER the coding agent commits (exit 0 = the loop is done), the repo-relative
   * progress-log path the harness maintains, and the 1-based iteration number. The container
   * executor forwards these to the harness as the coding job's `validation` block; the
   * harness runs the command and reports the verdict on the result (never the model — that is
   * what keeps the exit condition a real programmatic check). Absent for every non-`ralph` step.
   */
  ralphValidation?: {
    command: string
    progressPath: string
    iteration: number
  }
  /**
   * The PRE-PR validation checks resolved for this run's service frame: the ordered shell
   * commands the harness runs against the checkout after the coding agent settles and BEFORE
   * opening a PR, plus the repair-round budget. Resolved by the engine (frame-chain walk over
   * the service's `validation_configs` row) and forwarded by the container executor onto the
   * coding job body — but ONLY for a dispatch that would open a PR, which is the whole point of
   * "pre-PR". The harness runs them generically off the job body (no agent-kind switch), feeds a
   * failure back to the agent, and refuses to open the PR while they are red. Absent when the
   * service configured none ⇒ the harness's existing path, unchanged. See
   * `docs/initiatives/pre-pr-validation.md`.
   */
  validationChecks?: {
    checks: { label: string; command: string }[]
    maxAttempts: number
  }
  /**
   * DEPENDENCY PREPOPULATION: the install command the harness runs against the checkout BEFORE
   * the agent's first turn, so a repo-aware agent reads a tree whose dependencies are actually
   * present instead of inferring what a library can do from a manifest entry.
   *
   * Resolved from the SAME frame-chain read as {@link validationChecks} (so it costs a dispatch
   * no extra round trip) but forwarded on the job body under a DIFFERENT rule: every dispatch
   * that gets a checkout — explore kinds and in-place fixers included — not only a PR-opening
   * one. A reviewer or an architect reading the tree needs the dependencies as much as a coder
   * does, and neither opens a PR.
   *
   * Best-effort in the harness by construction: a failed install is reported to the agent (which
   * may install what it needs itself) and the run continues. Absent ⇒ the harness's existing
   * path, unchanged. See `docs/initiatives/agent-dependency-prepopulation.md`.
   */
  dependencyInstall?: string
  /**
   * The BUGFIX REPRODUCTION the harness must PROVE for this run: the command that runs the
   * declared reproduction test(s), those test paths, and an optional setup command that makes a
   * fresh worktree runnable. Resolved by the engine from the run's prior `repro-test` step
   * declaration (gated on the task's `coder.reproductionProof` tri-state) and forwarded by the
   * container executor onto the coding job body — but ONLY for a dispatch that would open a PR,
   * the same rule as {@link validationChecks}, because the proof is published on that PR.
   *
   * The harness runs the command against the PRE-FIX tree and the FINAL tree in symmetric fresh
   * worktrees and reports both exit codes: only red-then-green is proof. Absent when the run is
   * not opted in or carries no declaration ⇒ the harness's existing path, unchanged. See
   * `backend/docs/adr/0033-bugfix-reproduction-proof.md`.
   */
  reproduction?: {
    command: string
    testPaths: string[]
    /**
     * How many declared test paths the engine dropped while resolving (over the cap, absolute,
     * traversing, over-long). Carried so the proof can state that the pre-fix tree was rebuilt
     * from an incomplete reproduction rather than silently reporting a verdict about it.
     */
    omittedTestPaths?: number
    setupCommand?: string
    maxAttempts: number
  }
  /**
   * The skills this dispatch applies, resolved by the engine (see {@link ResolvedSkill}). Two
   * sources merge into one list, in this order:
   *  - the running agent KIND's declared skills (`AgentKindDefinition.skills`) — bundled with the
   *    deployment's package, or referenced from the account's synced catalog;
   *  - the step's own picked skill (`stepOptions.skillId`), which is what the built-in `skill`
   *    kind runs.
   * Deduplicated by skill id, so a kind that declares the same skill a step picked carries it once.
   *
   * The container executor renders them HARNESS-AWARE: for the claude-code harness they travel as
   * the dedicated top-level `skills` job-body field (the harness installs each under
   * `CLAUDE_CONFIG_DIR/skills/<name>/` natively); for Pi/codex the instructions are folded into
   * the prompt and the resources materialised as `.cat-context/skill/*` files. Absent ⇒ no skills.
   */
  skills?: ResolvedSkill[]
  /**
   * The tool servers (MCP) wired for this dispatch — the running agent kind's declared servers,
   * minus any the running harness cannot serve or whose required credential did not resolve.
   * PROMPT-FACING and non-secret by construction: credentials ride the job body's dedicated
   * `mcpServers` field and never appear here (this object IS copied into the agent-context
   * telemetry snapshot). Absent ⇒ the kind declared none.
   */
  toolServers?: ResolvedToolServer[]
  /**
   * Tool servers the kind declared that were NOT wired for this dispatch, with the reason. The
   * prompt states them so the agent plans around a tool it does not have rather than discovering
   * that mid-run, and the run's snapshot records why. Absent ⇒ every declared server was wired.
   */
  unavailableToolServers?: UnavailableToolServer[]
  /**
   * The GENERATIVE BINARY INTEGRATIONS this step selected (`stepOptions.binaryOutput.generatorIds`),
   * resolved by the ENGINE against the deployment's `BinaryGeneratorRegistry`. The container
   * executor reads it to resolve each declared credential onto the job body; the agent's own
   * instructions come from the injected `.cat-context/binary-output/brief.md`, so nothing here is
   * a second copy of the prompt.
   *
   * Non-secret (a credential's KEY NAME, never its value), so the agent-context snapshot may
   * record it. Absent ⇒ the step selected none, which is a real state: it generates through what
   * its agent already has, and the brief says so.
   */
  binaryGenerators?: ResolvedBinaryGenerator[]
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
     * static resolution. Absent when the library module is not configured. Each
     * carries the fragment's human `title` (when it has one) so the prompt composer
     * can render each standard as its own labelled block and a reviewer can cite it
     * by title, plus the condensed `brief` an implementer kind folds INSTEAD of the body
     * (the winning tier's linked one, or a generated condensation of it) when the
     * resolver produced one — resolved alongside the body it condenses, never looked up
     * by id here.
     */
    resolvedFragments?: { id: string; title?: string; body: string; brief?: string }[]
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
      /**
       * Where the document came from (`figma`, `notion`, …, or `upload`). Carried so a reader can
       * tell a DESIGN document from prose — `isDesignSource` off this one field, rather than each
       * reader re-guessing from the URL's host, which is how a self-hosted source would be missed.
       */
      origin: DocumentOrigin
      /** Short plain-text excerpt for list/preview rendering. */
      excerpt: string
      /** One-line summary rendered into the in-prompt summary index. */
      summary: string
      /** Full normalized-Markdown body, materialised as a file for the agent to explore. */
      body: string
      /**
       * What the dispatch-time refresh concluded about this body's currency. Absent when no
       * refresher is wired, which the renderer treats exactly like "nothing to state" — the prior
       * behaviour, byte for byte.
       */
      freshness?: DocumentFreshness
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
   * Files prepared for the agent to read up front — the engine materialises them into the
   * container's `.cat-context/` alongside the linked-doc context (see {@link InjectedContextFile}),
   * and folds them into the user prompt for an inline caller. The `pr-reviewer` preOps use this to
   * hand the reviewer the PR diff + changed-file list so it skips the reconstruct-the-diff
   * exploration turns. Absent when nothing was injected.
   *
   * Two producers, and they ACCUMULATE rather than replace one another: a registered kind's preOps
   * contribute their {@link RepoOpResult.contextFiles} (repo-derived), and the context builder
   * contributes files derived from run STATE a preOp cannot see — a resumed PR review's prior slice
   * reports live on the step, not in the repo, and must not be gated on a resolved run repo.
   */
  injectedContextFiles?: InjectedContextFile[]
  /**
   * The reference design images this run's task already has (the frames its linked designs
   * retained plus the images a person uploaded against it), for a kind that CAPTURES views
   * (`agent.image === 'ui'`). The executor turns them into the manifest the harness downloads
   * into `.cat-context/reference-screenshots/`, the directory the UI-tester prompt names.
   *
   * ABSENT and EMPTY say different things and both are reachable: absent means this dispatch
   * never asked (a kind that captures nothing, or a deployment with no artifact storage), and an
   * empty `files` means it asked and the task has no reference at all. Neither is an error (a
   * tester with no references names its own views), but the executor only sends a manifest when
   * the set says SOMETHING, so the container never creates an empty directory that reads as "the
   * designs gave nothing".
   */
  referenceScreenshots?: ReferenceScreenshotSet
  /**
   * The pictures of this task's designs, for a kind that BUILDS or PLANS from one (the
   * `design-images` trait). The frames the task's linked designs retained plus the images a person
   * attached to it: the same reference set the capture path reads, put to the opposite use.
   *
   * Resolved by the ENGINE, which knows what the task holds. Whether they can actually reach the
   * model is a DISPATCH fact (the harness and the resolved model), so it lands separately on
   * {@link designImageDelivery} rather than gating this: the set has to survive an un-attachable
   * dispatch, or the prompt has nothing to name when it states what was withheld.
   *
   * Absent when the kind carries no such trait, when the deployment stores no binaries, or when
   * the task links no design.
   */
  designImages?: DesignImageSet
  /**
   * What THIS dispatch could do with {@link designImages}: attached, or refused with the cause.
   *
   * Set by the executor rather than the context builder, because both halves of the answer are
   * resolved at dispatch (the harness the job runs on, the model the step resolved to) and neither
   * is knowable while the context is being built. The same shape as `toolServers` /
   * `unavailableToolServers`: the engine states the intent, the dispatch states what became of it.
   *
   * Never absent while `designImages` is present. A run holding pictures its agent was not shown
   * must SAY so, or the agent reads the textual design description as everything the platform had.
   */
  designImageDelivery?: DesignImageDelivery
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
     * The resolved service-frame's block `type` (`service` / `frontend` / `library` / …). The
     * source of the frame CAPABILITY PROFILE (`frameProfile`): the deployer no-ops and the
     * tester runs in suite posture on a `library` frame regardless of its `provisioning`. Always
     * set when a frame resolves for the run, so a `library` frame with no provisioning still
     * carries its type to the deployer/tester prompt + infra spec.
     */
    type?: BlockType
    /**
     * The service-owned provisioning config — the provision type it produces
     * (`kubernetes` / `docker-compose` / `custom` / `infraless`) plus the in-repo
     * specifics. The Tester reads the type to pick its run mode (compose stand-up for
     * `docker-compose`, the provisioned env URL for `kubernetes`/`custom`, nothing for
     * `infraless`); the deployer merges it with the workspace handler at provision time.
     * On a `library` frame a declared `composePath` is repo-local TEST infra stood up on
     * localhost (see `testerInfraSpec`), NOT a deployable environment.
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
   * The service the work itself belongs to — the enclosing service FRAME's title and description,
   * resolved by the engine from the block's ancestry. This is the agent's answer to "what system
   * am I working on", and it was missing: a step's prompt named the pipeline, the block and every
   * PEER service in {@link involvedServices}, but never the block's OWN service. A container agent
   * could recover it by reading its checkout; an inline one (a reviewer, a panel participant) had
   * no way to, so a task titled "implement webhooks" arrived with no identified subject at all —
   * and a model asked for concrete output against an unidentified subject supplies one, commonly
   * the most salient proper noun in its prompt (the orchestration platform's own name).
   *
   * A DISCRIMINATED result rather than a nullable value, because the two ways of having no
   * service mean opposite things to the prompt: a frame-level run has none because the block IS
   * the service (nothing to say), while a task outside any service has none because the platform
   * genuinely does not know (which must be SAID — an unstated product may not read like an obvious
   * one). Left undefined by a caller that does not populate it at all, e.g. a test fake, so no
   * claim is rendered either way.
   */
  ownService?: OwnServiceContext
  /**
   * The per-case PARAMETERS a custom-typed task was invoked with: the create form's collected
   * values joined with the registered descriptor's labels (see {@link describeCustomTaskType}).
   * This is what turns a registered task type into a REUSABLE OPERATION: an org registers
   * "introduce an API" with a small form, and the entity / operations / auth answers reach the
   * agents that act on them. Without it the bag rode `block.taskTypeFields` and reached zero
   * prompts, so the whole per-case brief was invisible to every agent in the pipeline.
   *
   * Resolved ONCE per dispatch, beside the prompt override and the output budget, so the
   * container, inline and consensus paths cannot disagree about what the operation was asked for.
   * Absent whenever the block collected no custom values, which is every run of a built-in type,
   * so every existing prompt is byte-identical.
   */
  customTaskType?: CustomTaskTypeContext
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
   * Pre-existing branches of the PRIMARY target repo attached to this task as run input
   * (the apriori-branches initiative) — lifted verbatim by the engine from the task
   * block's `aprioriBranches`. Two modes with disjoint semantics:
   *  - a single `working` entry names the branch the run BUILDS INSIDE: the executor swaps
   *    it in for the deterministic `cat-factory/<blockId>` work branch (the PR opens from it,
   *    the CI gate polls it, the merger merges it), and it must already exist (a missing
   *    working branch fails the dispatch loudly — it is never created).
   *  - `reference` entries are read-only context branches the agent may inspect but never
   *    commit to (consumed in a later slice via the harness `referenceBranches` fetch).
   * Absent for a task with no apriori branches attached; a pure projection (self-contained),
   * so no repo reads here.
   */
  aprioriBranches?: AprioriBranch[]
  /**
   * For a `conflict-resolver` the conflicts gate dispatched on a multi-repo
   * (service-connections) task, which of the block's repos conflicted, set by the engine from
   * the gate's `step.gate.conflictTarget`. The container executor resolves THAT repo and clones
   * its PR (work) branch when it is a peer, and leaves the resolver on the own service when it
   * is the own repo. Absent ⇒ the own-service repo (the single-repo default). Only the
   * conflict-resolver reads it; every other kind ignores it.
   *
   * `repo` is what ADDRESSES the checkout and is always set. `frameId` rides along as
   * attribution when the conflicted pull request recorded one, and seeds the repo resolution;
   * nothing decides own-versus-peer on its presence, since a peer pull request recorded without
   * its frames would then read as an own-repo conflict.
   */
  conflictTarget?: { repo: string; frameId?: string }
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
   * The rounds this step's companion loop has ALREADY been through, oldest first — the memory
   * that turns a repeated grading into a ratchet instead of independent draws.
   *
   * Both sides of the loop receive it, framed by `role`:
   *  - `grader` (the companion itself): every verdict it has given so far. Without this it
   *    re-grades a revised document with no idea what it asked for last time, so it cannot tell
   *    "they fixed it" from "they never touched it", spends each round's attention on a fresh
   *    subset, and returns a score drawn from the same distribution however much improved. That
   *    is what makes a rework budget buy nothing, and it is the question the budget is spent to
   *    answer. The JUDGE bucket has had this from the start (`JudgeSubject.previousFindings`);
   *    this is the companion bucket catching up.
   *  - `producer` (the step being reworked): the EARLIER rounds only, because the current one is
   *    already in {@link revision} in the "here is what to fix" framing. It stops a producer from
   *    regressing on a point raised two rounds ago, which nothing else tells it about.
   *
   * Absent on the first grading of a step, on every non-companion step, and on the human
   * "request changes" path (one person's review is not a loop with a history).
   */
  priorReview?: {
    role: 'grader' | 'producer'
    /** The bar every round was judged against, so a score in the list is readable. */
    threshold: number
    /** How many automatic rework rounds this loop may still spend; 0 ⇒ this is the last. */
    roundsRemaining: number
    rounds: {
      /** 1-based, in the order they happened. */
      round: number
      rating: number
      passed: boolean
      summary: string
      comments?: { quotedSource?: string; body: string }[]
    }[]
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
     * Whether a stakeholder INTERVIEW step still lies ahead of the running step in THIS run's
     * pipeline. Resolved from the pipeline's own shape, not from the preset: `pl_initiative` leads
     * with the analyst and interviews after it (`true` for the analyst), while `pl_initiative_docs`
     * and any other `interview: 'skip'` planning pipeline has no interviewer at all (`false`).
     *
     * It exists because the analyst is SHARED across those pipelines while the reason it must read
     * rather than defer differs: with an interview ahead, every fact it establishes is one a human
     * is not asked about their own codebase; with none, this analysis is the only reading of the
     * repository the plan will ever get. Both motivate the same behaviour, and each is FALSE for
     * the other pipeline — so the framing is selected here rather than asserted unconditionally.
     *
     * Present only on an initiative-LEVEL (planning) run; a spawned run carries preset steering
     * alone. Reports the step's presence, not whether its interviewer is wired — an unwired
     * interviewer passes through, which makes reading MORE important, never less.
     */
    interviewFollows?: boolean
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
   * A `ralph` step iteration's harness-computed validation verdict (whether the configured
   * completion command exited 0, its exit code, and a bounded output tail). Produced by the
   * executor-harness running the command — NOT model output — so the loop's exit condition
   * stays a real programmatic check. The engine reads it to decide done / retry / exhausted.
   * Carried as `unknown` so the port stays free of the contracts schema; the engine parses
   * it before use. Absent for every non-`ralph` kind.
   */
  ralphVerdict?: unknown
  /**
   * A coding step's PRE-PR validation report: which of the service's configured check commands
   * passed against the checkout, their exit codes and bounded/secret-scrubbed output tails, and
   * how many agent+check rounds the harness spent. Produced by the executor-harness running the
   * commands — NOT model output. The engine records it on the step (`PipelineStep.validation`)
   * on both the passing path (the captured proof the PR was green before it opened) and the
   * exhausted path (the evidence behind the failure). Carried as `unknown` so the port stays
   * free of the contracts schema; the engine parses it before use. Absent when the service
   * configured no checks.
   */
  validationReport?: unknown
  /**
   * A coding step's BUGFIX REPRODUCTION PROOF: the declared reproduction command run against the
   * pre-fix tree and the final tree, with both exit codes and bounded/secret-scrubbed output —
   * or the agent's structural declaration that reproduction was infeasible, with its reason and
   * stated alternative verification. Produced by the executor-harness running the command, NOT
   * model output. The engine records it on the step (`PipelineStep.reproduction`). Carried as
   * `unknown` so the port stays free of the contracts schema; the engine parses it before use.
   * Absent when the run carried no declaration or was not opted in.
   */
  reproductionReport?: unknown
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
   * The container agent's self-assessment of the work it did — how hard/easy it was, what
   * reduced its effectiveness, the key obstacles — lifted by the harness from the agent's
   * sentinel-file report. The engine records it on the step (`PipelineStep.effortReport`) for
   * run details. Absent for inline agents / when the agent wrote no report / older harness.
   */
  effortReport?: AgentEffortReport
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
   * What an INLINE dispatch will do with the tool servers (MCP) the running agent kind declared,
   * answered BEFORE the work, the counterpart of {@link AgentJobHandle.toolServers} on the path
   * that returns a result instead of a handle.
   *
   * Its one producer today is the consensus executor: a diverted step runs as inline model calls
   * with no agent CLI to wire a server into, so every declared server is WITHHELD, and the record
   * is what stops that reading as a step whose kind declared none. An inline executor with nothing
   * to withhold returns undefined rather than two empty lists: an inline surface never wires
   * anything, so an all-empty resolution from one would state that a resolution happened where no
   * wiring was ever possible.
   *
   * A PREVIEW rather than a field on {@link AgentRunResult}, for the same reason
   * {@link AgentExecutor.resolveModel} is one: the container path records its resolution off the
   * job handle at dispatch, so the record outlives a job that later fails, and a result-carried
   * field is by construction absent on exactly the runs where a reader most needs to know what the
   * agent could reach. Must be cheap and side-effect-free: the answer comes from the kind's
   * DECLARATIONS, never from resolving credentials for a dispatch that has nowhere to send them.
   *
   * Carries no agent kind for the same reason the handle's does not: the engine stamps the
   * DISPATCHED kind as it folds, so an executor cannot label a resolution with a kind other than
   * the one that ran.
   */
  previewToolServers?(context: AgentRunContext): Promise<DispatchToolServers | undefined>
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
  /**
   * What this dispatch did with the tool servers (MCP) the running agent kind declared: the ones
   * it wired, and the ones it dropped with the reason it dropped them. Recorded on the step
   * immediately, for the same reason {@link model} and {@link search} are: the poll site rebuilds
   * this handle from the STEP alone, so a dispatch-time resolution not recorded here is gone by
   * the time the job settles.
   *
   * It genuinely cannot be re-derived later: whether a server is servable depends on the resolved
   * harness and on the facade-wired secret/OAuth resolvers at that moment, and a workspace that
   * fills in a missing credential an hour later would make a step that ran without the tool read
   * as one that had it. Absent for executors that wire no tool servers (inline agents, tests).
   *
   * Carries no agent kind: `recordDispatchAttribution` stamps the DISPATCHED kind on it as it
   * folds, from the same parameter that feeds `step.dispatches`, so an executor cannot label a
   * resolution with a kind other than the one the engine dispatched.
   */
  toolServers?: DispatchToolServers
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
      /**
       * Epoch ms of the harness's last sign of life (forwarded from {@link RunnerJobView.heartbeatAt}),
       * so a quiet-but-alive job keeps advancing the step's throttled `lastActivityAt` — and thus the
       * run's `updated_at` — even when no subtask/phase changed. Absent on an older harness image.
       */
      lastActivityAt?: number
      /**
       * The LATEST pre-PR validation attempt's report (forwarded from
       * {@link RunnerJobView.validationReport}), so the engine can surface "lint failed,
       * repairing (attempt 2 of 3)" on the step WHILE the loop is still running. Absent for a
       * job whose service configured no checks / on an older harness image.
       */
      validationReport?: unknown
      /**
       * The reproduction proof as it stands mid-run (forwarded from
       * {@link RunnerJobView.reproductionReport}), so the engine can surface "verifying the
       * reproduction" / a failed verification on the step WHILE the loop is still running.
       * Absent for a job carrying no declaration / on an older harness image.
       */
      reproductionReport?: unknown
      /**
       * The per-slice reviews a parallel PR review has captured so far (forwarded from
       * {@link RunnerJobView.sliceReviews}), so the engine can persist each slice's completed
       * review work as it lands instead of only from the terminal structured output.
       *
       * Unlike the two reports above this is not merely for surfacing: the reviewer returns its
       * `slices`/`findings` ONLY at completion, so before this a review killed mid-run — or one
       * whose aggregation pass wedged — lost every finished slice and could only be re-run from
       * zero. What the engine folds from here is what a manual resume re-aggregates from. Absent
       * for a job that dispatched no subagents / on an older harness image.
       */
      sliceReviews?: unknown
      /**
       * What the agent's CLI reported about the tool servers it loaded (forwarded from
       * {@link RunnerJobView.toolServers}), so the step's tool-server record gains the OBSERVED
       * half while the run is still going — which is when a failed server is still worth acting
       * on. Absent for a job that wired none, a harness whose CLI reports nothing, or an older
       * image; the engine records that as "not observed", never as a failure.
       */
      toolServers?: unknown
    }
  /**
   * Finished successfully; `result` carries the work product. `followUps`, when present,
   * carries any final burst of streamed items the harness drained on the SAME poll that
   * observed completion (the tailer is flushed before the job is marked done), so the
   * engine never loses the last items — notably a question that must hold the gate.
   * `toolServers` carries the CLI's startup report for the same reason it rides the failed
   * variant: a job short enough to settle between two polls is never seen `running` at all, so
   * the settled poll is the ONLY one that can deliver it.
   */
  | { state: 'done'; result: AgentRunResult; followUps?: StreamedFollowUp[]; toolServers?: unknown }
  /**
   * Finished with a failure (agent error, inactivity/max-duration watchdog, …). When the
   * harness reported a STRUCTURED `failureCause`, it is forwarded here so the driver can
   * classify the failure (→ `AgentFailureKind`) without regex-matching `error`; absent on an
   * older harness image (the driver falls back to the error-string regex). `detail` carries an
   * extended, redacted diagnostic (phase timings, last-tool breadcrumb) distinct from the
   * one-line `error`, surfaced as the failure detail on the board. `evicted` carries the
   * transport's STRUCTURED container-eviction classification (forwarded from
   * {@link RunnerJobView.evicted}) so the driver recovers it on the right budget without
   * regex-matching `error`; absent on a non-eviction failure or an older producer.
   */
  | {
      state: 'failed'
      error: string
      failureCause?: HarnessFailureCause
      detail?: string
      backend?: string
      evicted?: ContainerEvictionKind
      /**
       * The pre-PR validation report of a job that failed BECAUSE its checks stayed red until
       * the attempt budget was spent — the evidence behind the failure (each command's exit code
       * + a bounded, secret-scrubbed output tail). The engine records it on the step beside the
       * failure detail. Absent for every other failure and for a job with no checks configured.
       */
      validationReport?: unknown
      /**
       * The reproduction proof of a job that failed for an UNRELATED reason after the proof ran
       * (a red pre-PR validation check, an eviction). A failed verification never fails a job by
       * itself (see the initiative's D6), so this is evidence carried alongside someone else's
       * failure — recorded on the step so the work is not lost with the run.
       */
      reproductionReport?: unknown
      /**
       * What the agent's CLI reported about the tool servers it loaded (forwarded from
       * {@link RunnerJobView.toolServers}). Carried on the FAILED path deliberately, and this is
       * the disposition that matters most: a run that failed after the prompt promised it tools
       * its CLI never managed to start is exactly the run whose post-mortem needs this, and a job
       * that dies before its first successful poll would otherwise carry no observation at all.
       */
      toolServers?: unknown
    }

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
