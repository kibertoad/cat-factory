// The SDK's PUBLIC shape: how the 41 `/api/v1` operations are grouped into resource clients
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

  // ---- Pipelines ------------------------------------------------------------------------
  listPublicPipelines: { group: 'pipelines', method: 'list' },

  // ---- Notifications --------------------------------------------------------------------
  listPublicNotifications: { group: 'notifications', method: 'list' },
  actPublicNotification: { group: 'notifications', method: 'act' },
  dismissPublicNotification: { group: 'notifications', method: 'dismiss' },

  // ---- The outbound webhook (push enrolment) ---------------------------------------------
  getPublicNotificationWebhook: { group: 'webhook', method: 'get' },
  putPublicNotificationWebhook: { group: 'webhook', method: 'set' },
  deletePublicNotificationWebhook: { group: 'webhook', method: 'delete' },

  // ---- Usage ----------------------------------------------------------------------------
  getPublicUsage: { group: 'usage', method: 'get' },

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

  // ---- Run diagnostics (`read` scope; the surface an operator or an LLM debugs a run with) -
  listDebugRuns: { group: 'debug', method: 'listRuns', paginates: 'runs' },
  getDebugRun: { group: 'debug', method: 'getRun' },
  listDebugLlmCalls: { group: 'debug', method: 'listLlmCalls', paginates: 'calls' },
  getDebugLlmCall: { group: 'debug', method: 'getLlmCall' },
  listDebugAgentContext: { group: 'debug', method: 'listAgentContext', paginates: 'snapshots' },
  getDebugAgentContext: { group: 'debug', method: 'getAgentContext' },
  listDebugLogs: { group: 'debug', method: 'listLogs', paginates: 'entries' },
  listDebugSearchQueries: {
    group: 'debug',
    method: 'listSearchQueries',
    paginates: 'queries',
  },
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
  streamPublicJobEvents:
    'A tool call returns one result, so it has no channel to stream an open-ended event feed ' +
    'over. Poll `jobs_get` instead, or consume the SSE endpoint through an SDK.',
  streamPublicTaskRun:
    'A tool call returns one result, so it has no channel to stream a run over. Poll ' +
    '`tasks_get_run` instead (a parked run waits for a human indefinitely, so a bounded "wait ' +
    'for the run to finish" tool would be a timeout dressed up as an answer), or consume the ' +
    'SSE endpoint through an SDK.',
}

/** One-line descriptions of each resource client, rendered into every SDK's docs. */
export const GROUP_DOCS = {
  jobs: 'Headless jobs (a public, inline pipeline run against a brief): start, poll or stream one.',
  services: "The workspace's board services — the frames tasks are created under.",
  tasks: "A board task's whole lifecycle: create, edit, start, stop, retry, watch, delete.",
  pipelines: 'The pipelines a task can be started with, and whether each is headless-startable.',
  notifications: "The workspace's human-actionable inbox: list, act on, or dismiss a run tail.",
  webhook:
    "The workspace's one outbound endpoint: register, inspect or remove the receiver that notifications, run-lifecycle events and health alerts are pushed to.",
  usage: "The billing period's metered budget position and the per-model breakdown behind it.",
  decisions:
    "A parked run's human decisions — requirement findings, forks, judge verdicts and the pre-token input gate.",
  debug: "A run's recorded telemetry: LLM calls, the context each agent was given, infra logs.",
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
