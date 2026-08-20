// The SDK's PUBLIC shape: how the `/api/v1` operations are grouped into resource clients
// and what each method is called.
//
// This is a chosen table, not a derivation, for the same reason `OPERATION_DOCS` in
// `scripts/generate-openapi.mjs` is: an `operationId` is a spec-internal identifier
// (`getPublicJob`, `resolvePublicRunRequirementsExceeded`), while a method name is read by
// every user of four SDKs. Deriving one from the other means a rename inside the contracts
// silently renames a published API in four languages; naming them here means that rename is a
// diff someone approves. Generation FAILS on an operation with no entry, so a new endpoint
// cannot ship as an un-callable hole in the SDK.
//
// `group` is the resource client (`client.tasks`), `method` the call on it. Both are given in
// camelCase; each emitter re-spells them for its language (snake_case in Python, PascalCase in
// Go). Method names deliberately drop the `Public`/`Run` noise the operationIds carry, since
// the group already says what resource is being addressed.

const SURFACE = {
  // ---- Jobs: headless runs of a public, inline pipeline against a supplied brief ---------
  createPublicJob: { group: 'jobs', method: 'create' },
  listPublicJobs: { group: 'jobs', method: 'list', paginates: 'jobs' },
  getPublicJob: { group: 'jobs', method: 'get' },
  cancelPublicJob: { group: 'jobs', method: 'cancel' },
  streamPublicJobEvents: { group: 'jobs', method: 'stream' },

  // ---- Services -------------------------------------------------------------------------
  listPublicServices: { group: 'services', method: 'list' },
  createPublicService: { group: 'services', method: 'create' },
  updatePublicService: { group: 'services', method: 'update' },
  deletePublicService: { group: 'services', method: 'delete' },

  // ---- The service SPEC: what a service is committed to honouring -------------------------
  // Its own group rather than a `services.getSpec`, because the spec is a resource in its own
  // right (the join partner of `evidence.getReport`) and the group is where the phase-2 sibling
  // that serves the rendered Gherkin alone would land.
  getPublicServiceSpec: { group: 'spec', method: 'get' },
  // `getForRun`, not `getRun`: the resource is still the SPEC, read at the run's ref. A caller
  // reading `client.spec.getForRun(runId)` beside `client.spec.get(serviceId)` is choosing a ref,
  // which is the choice these two exist to make explicit.
  getPublicRunSpec: { group: 'spec', method: 'getForRun' },

  // ---- Repositories: what a service can be created against --------------------------------
  listPublicRepos: { group: 'repos', method: 'list' },
  // `bootstrap`/`getBootstrap` and not a `bootstraps` group of their own: the resource being
  // created is a REPOSITORY, and a caller reading `client.repos.bootstrap(...)` beside
  // `client.repos.list()` is choosing between the repositories that exist and making one.
  startPublicRepoBootstrap: { group: 'repos', method: 'bootstrap' },
  getPublicRepoBootstrap: { group: 'repos', method: 'getBootstrap' },
  // `listAvailable`/`link` and not a group of their own: a caller choosing what to file work against
  // is choosing between the repositories this workspace already has (`list`), the ones it could adopt
  // (`listAvailable`), adopting one (`link`) and making a new one (`bootstrap`). Four methods, one
  // decision.
  listPublicAvailableRepos: { group: 'repos', method: 'listAvailable' },
  linkPublicRepo: { group: 'repos', method: 'link' },
  // `getFile` on the repos group and not a `contents` group of its own: the resource being read is
  // a REPOSITORY, and one file out of it is a read on that repository rather than a resource with
  // its own lifecycle. It also keeps the pairing legible: `link` adopts one, `getFile` reads what a
  // run wrote into it.
  getPublicRepoFile: { group: 'repos', method: 'getFile' },

  // ---- Tasks ----------------------------------------------------------------------------
  createPublicTask: { group: 'tasks', method: 'create' },
  listPublicServiceTasks: { group: 'tasks', method: 'listByService', paginates: 'tasks' },
  getPublicTask: { group: 'tasks', method: 'get' },
  updatePublicTask: { group: 'tasks', method: 'update' },
  deletePublicTask: { group: 'tasks', method: 'delete' },
  startPublicTask: { group: 'tasks', method: 'start' },
  stopPublicTask: { group: 'tasks', method: 'stop' },
  retryPublicTask: { group: 'tasks', method: 'retry' },
  getPublicRun: { group: 'tasks', method: 'getRun' },
  streamPublicTaskRun: { group: 'tasks', method: 'stream' },
  addPublicTaskDependency: { group: 'tasks', method: 'addDependency' },
  removePublicTaskDependency: { group: 'tasks', method: 'removeDependency' },
  listPublicTaskDocuments: { group: 'tasks', method: 'listDocuments' },
  attachPublicTaskDocument: { group: 'tasks', method: 'attachDocument' },
  detachPublicTaskDocument: { group: 'tasks', method: 'detachDocument' },

  // ---- Pipelines ------------------------------------------------------------------------
  listPublicPipelines: { group: 'pipelines', method: 'list' },

  // ---- Task types: what a task may be created AS, and the form each one accepts -----------
  listPublicTaskTypes: { group: 'taskTypes', method: 'list' },

  // ---- Inline use cases: the deployment's own NON-CONTAINER model operations ---------------
  // Their own group rather than methods on `models`: `models.list` answers what this deployment
  // could dispatch to at all, while a use case is a named piece of work with its own narrowed
  // model list, its own form and its own invocation. A caller reading `client.useCases.list()`
  // beside `client.useCases.invoke(...)` is choosing what to generate, not which model exists.
  listPublicUseCases: { group: 'useCases', method: 'list' },
  getPublicUseCase: { group: 'useCases', method: 'get' },
  invokePublicUseCase: { group: 'useCases', method: 'invoke' },

  // ---- Environments: the cluster a run's per-PR environment is provisioned onto -------------
  // `connections`, not `handlers`: the caller is describing a connection to infrastructure,
  // where "handler" names the engine-side object that services it.
  connectPublicEnvironment: { group: 'environments', method: 'connect' },
  listPublicEnvironmentConnections: { group: 'environments', method: 'listConnections' },
  testPublicEnvironmentConnection: { group: 'environments', method: 'testConnection' },

  // ---- What this deployment has WIRED ------------------------------------------------------
  // Three groups rather than one `wiring` bag: each names a real resource a caller asks about on
  // its own, and a bag's shape would have been dictated by whatever the first consumer happened
  // to probe.
  listPublicWiredModels: { group: 'models', method: 'list' },
  getPublicVcsConnection: { group: 'vcs', method: 'getConnection' },
  listPublicRiskPolicies: { group: 'riskPolicies', method: 'list' },
  listPublicModelPresets: { group: 'modelPresets', method: 'list' },

  // ---- The workspace's tracker writeback disposition ----------------------------------------
  // A `tracker` group with `getWriteback`/`updateWriteback` rather than a `trackerWriteback` group
  // with `get`/`update`: the resource is the workspace's TRACKER configuration, of which the
  // writeback disposition is the half `/api/v1` publishes today. The filing selection (which
  // tracker raises a tech-debt ticket, and that vendor's target) is the sibling this leaves room
  // for, and it would be `tracker.getSettings` beside these rather than a second group.
  getPublicTrackerWriteback: { group: 'tracker', method: 'getWriteback' },
  updatePublicTrackerWriteback: { group: 'tracker', method: 'updateWriteback' },

  // ---- Notifications --------------------------------------------------------------------
  listPublicNotifications: { group: 'notifications', method: 'list' },
  actPublicNotification: { group: 'notifications', method: 'act' },
  dismissPublicNotification: { group: 'notifications', method: 'dismiss' },

  // ---- The outbound webhooks (push enrolment) --------------------------------------------
  // The unsuffixed trio addresses the `default` endpoint; the `*Named` ones take an id, so a
  // caller enrolling its OWN receiver never has to know what else the workspace registered.
  getPublicNotificationWebhook: { group: 'webhook', method: 'get' },
  putPublicNotificationWebhook: { group: 'webhook', method: 'set' },
  deletePublicNotificationWebhook: { group: 'webhook', method: 'delete' },
  listPublicNotificationWebhooks: { group: 'webhook', method: 'list' },
  getPublicNamedNotificationWebhook: { group: 'webhook', method: 'getNamed' },
  putPublicNamedNotificationWebhook: { group: 'webhook', method: 'setNamed' },
  deletePublicNamedNotificationWebhook: { group: 'webhook', method: 'deleteNamed' },

  // ---- Usage ----------------------------------------------------------------------------
  getPublicUsage: { group: 'usage', method: 'get' },
  getPublicSpend: { group: 'usage', method: 'spend' },

  // ---- Key introspection (`read` scope; the startup self-check) --------------------------
  getPublicIdentity: { group: 'me', method: 'get' },

  // ---- Parked human decisions -----------------------------------------------------------
  listPublicRunDecisions: { group: 'decisions', method: 'list' },
  choosePublicRunFork: { group: 'decisions', method: 'chooseFork' },
  resolvePublicRunJudge: { group: 'decisions', method: 'resolveJudge' },
  resolvePublicRunInputGate: { group: 'decisions', method: 'resolveInputGate' },
  setPublicRunFindingStatus: { group: 'decisions', method: 'setFindingStatus' },
  replyPublicRunFinding: { group: 'decisions', method: 'replyToFinding' },
  incorporatePublicRunRequirements: { group: 'decisions', method: 'incorporate' },
  proceedPublicRunRequirements: { group: 'decisions', method: 'proceed' },
  reReviewPublicRunRequirements: { group: 'decisions', method: 'reReview' },
  resolvePublicRunRequirementsExceeded: { group: 'decisions', method: 'resolveExceeded' },
  approvePublicRunStep: { group: 'decisions', method: 'approveStep' },
  requestPublicRunStepChanges: { group: 'decisions', method: 'requestStepChanges' },
  rejectPublicRunStep: { group: 'decisions', method: 'rejectStep' },
  resolvePublicRunStepExceeded: { group: 'decisions', method: 'resolveStepExceeded' },
  resolvePublicRunAgentDecision: { group: 'decisions', method: 'answerAgentDecision' },
  replyPublicRunClarityFinding: { group: 'decisions', method: 'replyToClarityFinding' },
  setPublicRunClarityFindingStatus: { group: 'decisions', method: 'setClarityFindingStatus' },
  incorporatePublicRunClarity: { group: 'decisions', method: 'incorporateClarity' },
  reReviewPublicRunClarity: { group: 'decisions', method: 'reReviewClarity' },
  proceedPublicRunClarity: { group: 'decisions', method: 'proceedClarity' },
  resolvePublicRunClarityExceeded: { group: 'decisions', method: 'resolveClarityExceeded' },
  replyPublicRunBrainstormOption: { group: 'decisions', method: 'replyToBrainstormOption' },
  setPublicRunBrainstormOptionStatus: { group: 'decisions', method: 'setBrainstormOptionStatus' },
  incorporatePublicRunBrainstorm: { group: 'decisions', method: 'incorporateBrainstorm' },
  reReviewPublicRunBrainstorm: { group: 'decisions', method: 'reReviewBrainstorm' },
  proceedPublicRunBrainstorm: { group: 'decisions', method: 'proceedBrainstorm' },
  resolvePublicRunBrainstormExceeded: { group: 'decisions', method: 'resolveBrainstormExceeded' },
  resolvePublicRunPrReview: { group: 'decisions', method: 'resolvePrReview' },
  dismissPublicRunPrReviewFinding: { group: 'decisions', method: 'dismissPrReviewFinding' },
  challengePublicRunPrReviewFinding: { group: 'decisions', method: 'challengePrReviewFinding' },
  confirmPublicRunHumanTest: { group: 'decisions', method: 'confirmHumanTest' },
  requestPublicRunHumanTestFix: { group: 'decisions', method: 'requestHumanTestFix' },
  approvePublicRunVisualConfirm: { group: 'decisions', method: 'approveVisualConfirmation' },
  requestPublicRunVisualConfirmFix: { group: 'decisions', method: 'requestVisualConfirmationFix' },
  filePublicRunFollowUp: { group: 'decisions', method: 'fileFollowUp' },
  sendBackPublicRunFollowUp: { group: 'decisions', method: 'sendBackFollowUp' },
  answerPublicRunFollowUp: { group: 'decisions', method: 'answerFollowUp' },
  dismissPublicRunFollowUp: { group: 'decisions', method: 'dismissFollowUp' },
  answerPublicRunInterview: { group: 'decisions', method: 'answerInterviewQuestion' },
  continuePublicRunInterview: { group: 'decisions', method: 'continueInterview' },
  proceedPublicRunInterview: { group: 'decisions', method: 'proceedInterview' },

  // ---- Run evidence (`read` scope; what a run PROVED, for a consumer that has to judge it) --
  getPublicRunReport: { group: 'evidence', method: 'getReport' },
  getPublicRunOutcome: { group: 'evidence', method: 'getOutcome' },
  listPublicRunArtifacts: { group: 'evidence', method: 'listArtifacts' },
  getPublicArtifactBlob: { group: 'evidence', method: 'downloadArtifact' },

  // ---- Merge evidence (`read` to look, `write` to tag; never `admin`, which is what MERGES) --
  getPublicRunMergeRecord: { group: 'mergeRecords', method: 'getForRun' },
  getPublicMergeRecord: { group: 'mergeRecords', method: 'get' },
  listPublicMergeClassRollups: { group: 'mergeRecords', method: 'listRollups' },
  tagPublicMergeReviewEffort: { group: 'mergeRecords', method: 'tagEffort' },

  // ---- Kaizen entries (`read` to consume the backlog, `write` to acknowledge one) ----------
  listPublicKaizenEntries: { group: 'kaizen', method: 'listEntries', paginates: 'entries' },
  getPublicKaizenEntry: { group: 'kaizen', method: 'getEntry' },
  acknowledgePublicKaizenEntry: { group: 'kaizen', method: 'acknowledgeEntry' },

  // ---- Headless key provisioning (`admin` scope) ------------------------------------------
  listPublicKeys: { group: 'keys', method: 'list' },
  createPublicKey: { group: 'keys', method: 'create' },
  revokePublicKey: { group: 'keys', method: 'revoke' },

  // ---- Run diagnostics (`read` scope; the surface an operator or an LLM debugs a run with) -
  listDebugRuns: { group: 'debug', method: 'listRuns', paginates: 'runs' },
  getDebugRun: { group: 'debug', method: 'getRun' },
  listDebugLlmCalls: { group: 'debug', method: 'listLlmCalls', paginates: 'calls' },
  getDebugLlmCall: { group: 'debug', method: 'getLlmCall' },
  getDebugLlmExport: { group: 'debug', method: 'getLlmExport' },
  listDebugAgentContext: { group: 'debug', method: 'listAgentContext', paginates: 'snapshots' },
  getDebugAgentContext: { group: 'debug', method: 'getAgentContext' },
  listDebugToolCalls: { group: 'debug', method: 'listToolCalls', paginates: 'toolCalls' },
  listDebugLogs: { group: 'debug', method: 'listLogs', paginates: 'entries' },
  listDebugSearchQueries: {
    group: 'debug',
    method: 'listSearchQueries',
    paginates: 'queries',
  },
}

/**
 * Which telemetry SINK each `/api/v1/debug/*` read draws its rows from, or `null` for the two
 * that project the run itself.
 *
 * This is the one policy fact about this API that a name cannot carry and a scope floor does not
 * express. The five sinks are where the platform keeps CAPTURED TEXT: model prompts and replies,
 * tool arguments and results, agent search terms, provisioning command output. All of it sits
 * inside a `read` key's floor, because it is a read, so the only thing standing between a
 * read-only Gatekeeper tier and a run's full transcript is a policy that names these operations.
 * A hand-typed list of those names is how `debug_get_llm_export` shipped granted to an observer
 * tier that denied every one of its siblings.
 *
 * The two `null` entries are the run's own lifecycle projection (ids, status, step shape,
 * aggregates and derived signals). They are the reads a status dashboard is built from, they
 * carry no captured text, and keeping them readable is why the classification is per-operation
 * rather than "the whole `/debug` prefix".
 *
 * Generation FAILS on a `debug` operation with no entry here and on an entry the spec no longer
 * has, so a new telemetry read cannot ship un-classified: it either names its sink and joins the
 * derived deny set, or states that it carries none.
 */
export const DEBUG_TELEMETRY_SINKS = {
  listDebugRuns: null,
  getDebugRun: null,
  listDebugLlmCalls: 'llmCalls',
  getDebugLlmCall: 'llmCalls',
  getDebugLlmExport: 'llmCalls',
  listDebugAgentContext: 'agentContext',
  getDebugAgentContext: 'agentContext',
  listDebugToolCalls: 'toolCalls',
  listDebugLogs: 'provisioningLog',
  listDebugSearchQueries: 'searchQueries',
}

/**
 * The operations the MCP facade (`sdk/mcp`) deliberately does NOT expose as a tool, each with the
 * reason a caller should read. Generation FAILS on a streaming operation that is not named here,
 * and on an entry naming an operation the spec no longer has.
 *
 * Exposure is the default and the absences are the exception, which is the opposite of how
 * {@link SURFACE} works, and deliberately so: an endpoint added to `/api/v1` should become a tool
 * without anyone deciding twice, but an endpoint that CANNOT be one has to say why, or its
 * absence reads as an oversight and a caller writes it off as unsupported.
 */
export const MCP_OMITTED_OPERATIONS = {
  getPublicArtifactBlob:
    'A tool result is text or a declared content block, not an arbitrary byte stream, so an ' +
    'image download has no honest shape here. Call `evidence_list_artifacts` for the ids, sizes ' +
    'and content types, and fetch the bytes over HTTP (or through an SDK) with the same key.',
  streamPublicJobEvents:
    'A tool call returns one result, so it has no channel to stream an open-ended event feed ' +
    'over. Poll `jobs_get` instead, or consume the SSE endpoint through an SDK.',
  streamPublicTaskRun:
    'A tool call returns one result, so it has no channel to stream a run over. Poll ' +
    '`tasks_get_run` instead (a parked run waits for a human indefinitely, so a bounded "wait ' +
    'for the run to finish" tool would be a timeout dressed up as an answer), or consume the ' +
    'SSE endpoint through an SDK.',
}

/**
 * The MCP tool annotations that cannot be derived from the HTTP method, per operation.
 *
 * `readOnlyHint` follows from the method and is emitted for every tool. These two do not: the
 * protocol's defaults for an UNSET hint are already the cautious ones (`destructiveHint` defaults
 * to true, `idempotentHint` to false), so a mutating tool that says nothing is treated as the
 * worst case and needs no entry. What an entry buys is the hint being STATED, which is what a host
 * showing a confirmation dialog reads, and it is worth stating exactly where the consequence is
 * real money or a merged pull request.
 *
 * Deliberately NOT a blanket pass over the mutating operations: setting `destructive: false` on a
 * cheap write would LOWER a host's caution below its own default, which is a guess dressed as
 * information. An operation absent from this table keeps the protocol's cautious default.
 *
 * Generation fails on an entry naming an operation the spec no longer has, and on one naming a GET
 * (a read changes nothing, so neither hint means anything about it).
 */
export const MCP_TOOL_HINTS = {
  // The four that spend: each begins a real agent run against a real repository, or merges a real
  // pull request. Not idempotent: a second call starts a second run.
  startPublicTask: { destructive: true, idempotent: false },
  retryPublicTask: { destructive: true, idempotent: false },
  createPublicJob: { destructive: true, idempotent: false },
  actPublicNotification: { destructive: true, idempotent: false },
  // Destructive AND idempotent, which is the pair `readOnlyHint` alone cannot express: deleting a
  // task twice leaves the board in the same state, and the first call is still irreversible.
  deletePublicTask: { destructive: true, idempotent: true },
  // The same pair one level up, and the consequence is strictly larger: a service delete takes its
  // whole subtree and every run recorded under it. Idempotent in EFFECT (a second call finds
  // nothing left to remove and 404s), which says nothing about the first one being recoverable.
  deletePublicService: { destructive: true, idempotent: true },
  // The outbound webhook, same pair and for a subtler reason: neither call spends anything, and
  // both overwrite state whose previous value cannot be recovered through this API: the endpoint
  // someone else's integration is registered at, and a signing secret that is never readable back.
  // What is lost is invisible from here, since the receiver that stops hearing from this workspace
  // is somewhere else entirely.
  putPublicNotificationWebhook: { destructive: true, idempotent: true },
  deletePublicNotificationWebhook: { destructive: true, idempotent: true },
  // The named pair carries the same annotation for the same reason. It is NOT softened by the
  // fact that each addresses one endpoint: what a caller overwrites is still a URL and a signing
  // secret it cannot read back, and whoever is holding the id it chose to write to may not be
  // whoever registered that endpoint.
  putPublicNamedNotificationWebhook: { destructive: true, idempotent: true },
  deletePublicNamedNotificationWebhook: { destructive: true, idempotent: true },
}

/** One-line descriptions of each resource client, rendered into every SDK's docs. */
export const GROUP_DOCS = {
  jobs: 'Headless jobs (a public, inline pipeline run against a brief): start, poll or stream one.',
  services:
    "The workspace's board services, the frames tasks are created under: list them, create one (optionally backed by a repository), patch one (including declaring where the manifests for its per-run environments are read from), or delete one with everything under it. The delete refuses a service holding unfinished tasks rather than discarding work in flight.",
  spec: "A service's in-repo specification: the structured requirement tree (modules → feature groups → requirements, with their acceptance criteria and domain rules), the Gherkin rendered from it, and the branch and commit the read describes. Read-only; the requirement ids are the join key onto a run's report and outcome.",
  repos:
    'The repositories this workspace can back a service with, and which service each already backs (the discovery half of service creation); the ones its connection could reach but has not adopted yet, and adopting one by name; plus creating a brand-new one, where a bootstrap writes the repository with an agent and reports the board service it materialises.',
  tasks:
    "A board task's whole lifecycle: create, edit, start, stop, retry, watch, delete, plus the two relationships that outlive a create: the tasks it waits for, and the requirements documents it is built against.",
  pipelines: 'The pipelines a task can be started with, and whether each is headless-startable.',
  taskTypes:
    'What a task can be created AS in this workspace (the built-in kinds plus the operations the deployment registered), and the fields each one accepts.',
  useCases:
    "The deployment's own non-container model operations: what it will generate for you, on which models, from which parameters, and running one. Each use case narrows the models it may run on and declares the form it accepts, so a wrapper renders a picker from the catalog rather than from a hard-coded copy; a model listed as unavailable says whether the deployment cannot serve it at all or has yet to configure the credential. Discovery takes a `read` key, invoking a `write` one: an invocation spends model tokens and returns text, and starts no run.",
  notifications: "The workspace's human-actionable inbox: list, act on, or dismiss a run tail.",
  environments:
    'The cluster this workspace provisions per-run environments onto: probe a candidate connection without saving it, or bind one. The credential is write-only, so a read reports which secret keys are stored and never their values.',
  models:
    'The models a run in this workspace could actually dispatch to, and why an unavailable one is unavailable: unconfigured, or refused by the account model-family policy. Those two need opposite fixes.',
  vcs: "The workspace's source-control connection: which account it talks to, how it authenticates, and whether it may create repositories and write workflow files. Both permissions are enforced by the provider at push time, so reading them beats discovering one missing halfway through an automated setup.",
  tracker:
    "What this workspace does to a task's LINKED tracker issue as its pull request progresses: comment when it opens, comment and close the issue when it merges, and post a headless run's parked review findings so the reporter can answer where they filed. The write MERGES, so turning one action on leaves the other two as they were. It is the writeback half of the workspace's tracker configuration; the filing selection (which tracker a tech-debt ticket is raised on) is not published yet.",
  riskPolicies:
    'The risk policies a task can pin, including which is the workspace default: what decides whether a run can land its pull request without a person, and how many attempts its CI fixer, requirement rounds and release watch are given. Broader than merging, which is why it is not called a merge preset.',
  modelPresets:
    'The model presets a task can pin, including which is the workspace default: what decides which model each agent step runs on, and so what a run costs. Availability is not repeated here; join `baseModelId` against the models group, which keeps unconfigured and policy-refused apart.',
  webhook:
    "The workspace's outbound endpoints: register, inspect or remove the receivers that notifications, run-lifecycle events and health alerts are pushed to. The unnamed calls address the `default` endpoint; the named ones let an integration enroll its own receiver, with its own signing secret and filters, beside whatever else is registered.",
  usage:
    "The workspace's money, two ways: the billing period's metered budget position with the per-model breakdown behind it, and spend over a window sliced by the dimension a budget is kept against (a repository, a tracker ticket, one run).",
  me: 'What the calling key is and what it may do — the self-check an integration runs at startup.',
  decisions:
    'Every way a run stops for a person: approval gates, review and brainstorm loops, forks, judge verdicts, PR review findings, the human-verdict gates, follow-up triage and the interview gates.',
  debug:
    "A run's recorded telemetry: LLM calls, the context each agent was given, the tool calls it made, infra logs, and the whole model-activity bundle as one document.",
  evidence:
    "What a run proved: the engine's verification report, the outcome summary behind it, and the artifacts it captured, bytes included.",
  mergeRecords:
    'The evidence behind the auto-merge policy: what kind of change each merged run made, what the merger scored it, what happened to the pull request, and how much review a human actually spent, plus the per-class rollups that justify widening a rule. Reading takes a `read` key and recording an effort tag a `write` one: neither merges anything.',
  kaizen:
    "The platform's own improvement backlog: every post-run grading of an agent step, with the agent kind, model, prompt version and run it came from, what the grader recommended changing, and whether anybody has acted on it yet. Reading takes a `read` key and acknowledging one a `write` key: neither runs anything.",
  keys: "The workspace's own API keys: provision one headlessly, list them, revoke one (and what it minted).",
}

/** The resource groups in emission order. */
export const GROUPS = Object.keys(GROUP_DOCS)

/**
 * Decorate the IR's operations with their surface placement, failing on an operation the table
 * does not name (a new endpoint that would otherwise be silently uncallable) and on an entry
 * naming an operation that no longer exists.
 */
export function placeOperations(ir) {
  const unused = new Set(Object.keys(SURFACE))
  const placed = ir.operations.map((operation) => {
    const entry = SURFACE[operation.id]
    if (!entry) {
      throw new Error(
        `SDK surface: operation '${operation.id}' (${operation.httpMethod} ${operation.path}) has no ` +
          'entry in SURFACE (scripts/sdk/surface.mjs). Name its resource group and method so it ' +
          'ships in all four SDKs.',
      )
    }
    unused.delete(operation.id)
    if (!GROUP_DOCS[entry.group]) {
      throw new Error(`SDK surface: group '${entry.group}' has no entry in GROUP_DOCS.`)
    }
    return { ...operation, ...entry }
  })
  if (unused.size > 0) {
    throw new Error(
      `SDK surface: SURFACE names operations the spec no longer has: ${[...unused].join(', ')}`,
    )
  }
  const collisions = new Map()
  for (const operation of placed) {
    const key = `${operation.group}.${operation.method}`
    if (collisions.has(key)) {
      throw new Error(
        `SDK surface: '${key}' is claimed by both '${collisions.get(key)}' and '${operation.id}'.`,
      )
    }
    collisions.set(key, operation.id)
  }
  return placed
}

/** Operations of one group, in method-name order. */
export function groupOperations(placed, group) {
  return placed
    .filter((operation) => operation.group === group)
    .sort((a, b) => a.method.localeCompare(b.method))
}
