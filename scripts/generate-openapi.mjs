// Generate an OpenAPI 3.1 document for the external public API (`/api/v1/*`) from the
// Valibot route contracts in `@cat-factory/contracts`, and write it to `docs/openapi.json`.
//
// No OpenAPI emitter ships in `@toad-contracts/*`, so this is a small purpose-built
// generator, twinned with `scripts/check-openapi.mjs` (the CI drift guard) exactly like
// `sync-runner-image-tags.mjs` ⇄ `check-runner-image-tag.mjs`. It covers ONLY the
// `/api/v1` surface (the external, key-authenticated API) — not the ~360 internal
// session-authed contracts. The generator filters by the resolved `/api/v1` path, so any
// future public endpoint added to that surface is picked up automatically.
//
// Prereqs: the contracts package must be BUILT first (it imports the compiled `dist`), so
// run `pnpm build` before `pnpm gen:openapi`.

import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { toJsonSchema, toJsonSchemaDefs } from '@valibot/to-json-schema'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACTS_DIST = resolve(repoRoot, 'backend/packages/contracts/dist/index.js')
export const OPENAPI_PATH = resolve(repoRoot, 'docs/openapi.json')

const API_PREFIX = '/api/v1'

// The document's `info.version` describes the PUBLIC API surface (`/api/v1`), NOT the npm
// package release. It is deliberately DECOUPLED from any `package.json` version: those bump on
// every changesets release with no bearing on the API contract, and baking one in would make the
// committed `docs/openapi.json` go stale on every release — the drift guard (`check:openapi`)
// would then fail spuriously on the next PR that merges a release, even when no contract changed.
//
// The public API is STABLE (see CLAUDE.md "The public API is stable"): additive changes bump the
// minor here; a breaking change is not allowed on `/api/v1` at all: it means a new `/api/v2`
// prefix served beside v1 through a deprecation window, and a new spec version with it.
const API_VERSION = '1.2.0'

/**
 * Named DTOs hoisted into `components.schemas` (so client codegen gets named types and
 * shared schemas aren't inlined N times): OpenAPI component name → the exported Valibot
 * schema's name in `@cat-factory/contracts`.
 */
const COMPONENT_SCHEMAS = {
  ErrorResponse: 'errorResponseSchema',
  PublicJob: 'publicJobSchema',
  PublicJobAccepted: 'publicJobAcceptedSchema',
  CreatePublicJob: 'createPublicJobSchema',
  PublicService: 'publicServiceSchema',
  PublicServiceList: 'publicServiceListSchema',
  PublicTask: 'publicTaskSchema',
  PublicTaskList: 'publicTaskListSchema',
  CreatePublicTask: 'createPublicTaskSchema',
  PublicTaskTicket: 'publicTaskTicketSchema',
  StartPublicTask: 'startPublicTaskSchema',
  UpdatePublicTask: 'updatePublicTaskSchema',
  PublicRun: 'publicRunSchema',
  PublicPipeline: 'publicPipelineSchema',
  PublicPipelineList: 'publicPipelineListSchema',
  Notification: 'notificationSchema',
  PublicNotificationList: 'publicNotificationListSchema',
  PublicUsageRow: 'publicUsageRowSchema',
  PublicUsageBudget: 'publicUsageBudgetSchema',
  PublicUsage: 'publicUsageSchema',
  // Parked decisions. `PublicDecisionList` is the response of ALL eight decision routes, and it
  // transitively carries the full finding + fork-option shapes — hoisting it (and the members of
  // its variant) keeps the spec from inlining ~21KB per operation.
  PublicReviewFinding: 'publicReviewFindingSchema',
  PublicRequirementsDecision: 'publicRequirementsDecisionSchema',
  PublicForkDecision: 'publicForkDecisionSchema',
  PublicInputGateDecision: 'publicInputGateDecisionSchema',
  PublicDecision: 'publicDecisionSchema',
  PublicDecisionList: 'publicDecisionListSchema',
  PublicReplyFinding: 'publicReplyFindingSchema',
  PublicSetFindingStatus: 'publicSetFindingStatusSchema',
  PublicIncorporate: 'publicIncorporateSchema',
  PublicResolveExceeded: 'publicResolveExceededSchema',
  PublicChooseFork: 'publicChooseForkSchema',
  PublicResolveInputGate: 'publicResolveInputGateSchema',
}

/** Per-operation docs, keyed by operationId (the exported contract const name minus `Contract`). */
const OPERATION_DOCS = {
  createPublicJob: {
    tag: 'Jobs',
    summary: 'Start a headless job',
    description:
      'Start a public, inline pipeline headlessly against a supplied brief. Returns a job id to poll or stream. Nothing is pushed to GitHub.',
  },
  getPublicJob: {
    tag: 'Jobs',
    summary: 'Get a job',
    description:
      'Poll a headless job started through this surface: its status and, once finished, its result.',
  },
  listPublicServices: {
    tag: 'Services',
    summary: "List the workspace's services",
    description:
      'List the board service frames in the key’s workspace, so a caller can discover the serviceId to create/list tasks under.',
  },
  createPublicTask: {
    tag: 'Tasks',
    summary: 'Create a task under a service',
    description:
      'Create a task inside a service frame the key’s workspace owns. The task starts in the `planned` state; start it with the start endpoint.',
  },
  listPublicServiceTasks: {
    tag: 'Tasks',
    summary: "List a service's tasks",
    description:
      'List every task under a service (the whole subtree — tasks directly under the frame and under its modules).',
  },
  getPublicTask: {
    tag: 'Tasks',
    summary: "Get a task's status",
    description:
      'Read a task’s current lifecycle status, run progress, run id, and PR URL (once one exists).',
  },
  startPublicTask: {
    tag: 'Tasks',
    summary: 'Start (run) a task',
    description:
      'Start a task’s pipeline. Uses the request’s pipelineId, else the task’s pinned pipeline. A pipeline that can park on a human decision requires a `decide`-scope key. A task on an individual-usage model cannot be started through the API (no headless personal-credential unlock).',
  },
  updatePublicTask: {
    tag: 'Tasks',
    summary: "Edit a task's title/description",
    description:
      'Edit a task’s human-authored fields (title/description) before it runs. Both fields are optional.',
  },
  stopPublicTask: {
    tag: 'Tasks',
    summary: "Stop a task's run",
    description:
      'Stop a task’s in-flight run. Records a `cancelled` terminal state, leaving the run retryable.',
  },
  retryPublicTask: {
    tag: 'Tasks',
    summary: "Retry a task's failed run",
    description:
      'Retry a task’s failed run. A task on an individual-usage model cannot be retried through the API (no headless personal-credential unlock).',
  },
  getPublicRun: {
    tag: 'Tasks',
    summary: "Get a task's run (rich projection)",
    description:
      'Read a task’s run in detail: per-step status/progress/subtasks, the failure kind and message, and the PR (url + branch).',
  },
  deletePublicTask: {
    tag: 'Tasks',
    summary: 'Delete a task',
    description:
      'Delete a task and its run history. Destructive, so it sits at the top of the scope ladder: requires an `admin`-scoped key.',
  },
  listPublicJobs: {
    tag: 'Jobs',
    summary: "List the workspace's jobs",
    description:
      'List the headless runs THIS surface created, newest first and keyset-paginated. Scoped to internal-anchored runs exactly like the single-job read, so an external key can never enumerate the workspace’s ordinary board runs.',
  },
  resolvePublicRunInputGate: {
    tag: 'Decisions',
    summary: "Resolve a run parked on the task's input check",
    description:
      'Settle a run the pre-token input gate parked before its first agent step because the task states nothing an agent could act on. `recheck` re-evaluates the task as it now stands (edit it over `PATCH /api/v1/tasks/{taskId}` first: the fix is verified, not taken on trust) and releases the run only if the blocking findings are gone; a still-blocked verdict comes back as an ordinary 200 with refreshed findings. `proceed` waives the findings, which stay on the run as an `overridden` record. Requires a `decide`-scope key.',
  },
  resolvePublicRunJudge: {
    tag: 'Decisions',
    summary: 'Resolve a parked judge verdict',
    description:
      'Settle a run parked on a judge verdict: proceed anyway, bounce the producing step for rework, or stop the run. Requires a `decide`-scope key.',
  },
  listPublicPipelines: {
    tag: 'Pipelines',
    summary: "List the workspace's pipelines",
    description:
      'List the pipelines in the key’s workspace — id/name/steps plus whether each is public and safe to run headlessly — so a caller can pick a pipelineId to start a task with.',
  },
  listPublicNotifications: {
    tag: 'Notifications',
    summary: "List the workspace's open notifications",
    description:
      'List the open, human-actionable notifications in the key’s workspace (merge reviews, pipeline-complete confirmations, CI/test failures, and informational cards).',
  },
  actPublicNotification: {
    tag: 'Notifications',
    summary: 'Act on a notification',
    description:
      'Run a notification’s typed side-effect and resolve it: merge the PR (merge_review / pipeline_complete) or retry the run (ci_failed / test_failed). Performs a real GitHub merge, so it requires an admin-scoped key. Only these automated-action types are actionable through the API — a notification that parks a run on an interactive human decision cannot be acted on headlessly (dismiss it instead). A card that would retry a run on an individual-usage model likewise cannot be acted on through the API.',
  },
  dismissPublicNotification: {
    tag: 'Notifications',
    summary: 'Dismiss a notification',
    description: 'Dismiss a notification without acting on it.',
  },
  getPublicUsage: {
    tag: 'Usage',
    summary: "Read the workspace's usage for the current period",
    description:
      'Read this billing period’s METERED spend against the workspace budget (including whether it is exceeded, which pauses runs) plus the per-(billing, vendor, provider, model) token breakdown behind it. Costs on `subscription` rows are illustrative — a flat-rate plan bills nothing per token — so branch on `billing` before summing. Workspace-scoped: the account- and user-tier budgets are not reachable through this surface.',
  },
  cancelPublicJob: {
    tag: 'Jobs',
    summary: 'Cancel a job',
    description:
      'Stop a headless job run, freeing its concurrency slot. Idempotent — an already-finished job is returned as-is. Use this to abandon a run parked on a decision you do not intend to answer.',
  },
  listPublicRunDecisions: {
    tag: 'Decisions',
    summary: "List a run's parked decisions",
    description:
      'Read what a run is currently asking a human: requirement-review findings (with the stable item ids a reply addresses) and any implementation-fork choice. `parked` is true while the run is blocked awaiting one of them.',
  },
  replyPublicRunFinding: {
    tag: 'Decisions',
    summary: 'Answer a review finding',
    description:
      "Record an answer to one reviewer finding. Returns the run's updated decision list. Requires a `decide`-scope key.",
  },
  setPublicRunFindingStatus: {
    tag: 'Decisions',
    summary: 'Dismiss or reopen a finding',
    description:
      'Dismiss a finding as not applicable, or reopen one dismissed by mistake. Requires a `decide`-scope key.',
  },
  incorporatePublicRunRequirements: {
    tag: 'Decisions',
    summary: 'Incorporate the answers',
    description:
      'Fold the recorded answers into one standardized requirements document. Asynchronous — the run re-reviews in the background, so the response shows the review `incorporating`. Requires a `decide`-scope key.',
  },
  reReviewPublicRunRequirements: {
    tag: 'Decisions',
    summary: 'Re-review the incorporated document',
    description:
      'Run one more reviewer pass over the incorporated document. On convergence the parked run advances. Requires a `decide`-scope key.',
  },
  proceedPublicRunRequirements: {
    tag: 'Decisions',
    summary: 'Proceed with the current requirements',
    description:
      'Settle the requirements phase and advance the parked run (used when nothing is outstanding). Requires a `decide`-scope key.',
  },
  resolvePublicRunRequirementsExceeded: {
    tag: 'Decisions',
    summary: 'Resolve a review at its iteration cap',
    description:
      'Pick how a review that exhausted its reviewer-pass budget proceeds: one more round, proceed with the last incorporated document, or stop and reset the task. Requires a `decide`-scope key.',
  },
  choosePublicRunFork: {
    tag: 'Decisions',
    summary: 'Choose an implementation approach',
    description:
      'Pick one of the proposed implementation forks (by id) or submit your own approach. The Coder then runs with the choice folded in as a binding directive. Requires a `decide`-scope key.',
  },

  // The remote-debugging reads (`/api/v1/debug/*`, `read` scope). A two-level drill-down: the
  // run-scoped lists live under `/debug/runs/:runId/*`, while a point read that carries BODIES is
  // addressed by the row's own id, so a caller holding a call id from a list need not also
  // remember the run it came from. Every response's size is computable before the request — lists
  // never carry bodies, and a body is reached at any offset through its own read.
  listDebugRuns: {
    tag: 'Debug',
    summary: "List the workspace's runs",
    description:
      'The triage entry point: the workspace’s runs, newest first and keyset-paginated, with an optional status and `since` filter.',
  },
  getDebugRun: {
    tag: 'Debug',
    summary: "Get a run's diagnostic map",
    description:
      'One run’s diagnostic overview: its steps, which telemetry sinks this deployment retains (and how much each holds), the LLM cost/latency rollups, and the derived signals worth looking at first.',
  },
  listDebugLlmCalls: {
    tag: 'Debug',
    summary: "List a run's LLM calls",
    description:
      'The model calls a run made, keyset-paginated and filterable by agent kind, phase, outcome or a substring of the bodies. Bodies are returned only when `bodyChars` asks for them.',
  },
  getDebugLlmCall: {
    tag: 'Debug',
    summary: 'Get one LLM call',
    description:
      'One recorded model call with its budgeted prompt delta, response and reasoning. `bodyOffset`/`bodyChars` window the bodies, so an arbitrarily long transcript is readable in bounded pages.',
  },
  listDebugAgentContext: {
    tag: 'Debug',
    summary: "List a run's agent-context dispatches",
    description:
      'Every dispatch whose provided context was captured, with SIZES only (no bodies) so the list stays bounded. Read one in full through the snapshot endpoint.',
  },
  getDebugAgentContext: {
    tag: 'Debug',
    summary: 'Get one agent-context snapshot',
    description:
      'The complete context one dispatch was PROVIDED: system and user prompts, the folded standards fragments, and the injected `.cat-context/*` files an agent reads through tools (which therefore appear in no proxy telemetry). Windowed by `bodyOffset`/`bodyChars`.',
  },
  listDebugSearchQueries: {
    tag: 'Debug',
    summary: "List a run's web searches",
    description:
      'The web searches the run’s agents actually performed, keyset-paginated. Retained only when the deployment records agent context.',
  },
  listDebugLogs: {
    tag: 'Debug',
    summary: "List a run's infrastructure log",
    description:
      'The run’s provisioning event log — how its environment, runner pool and containers came up, or why they did not.',
  },
}

/** Descriptions for the operation tags (groups). */
const TAG_DESCRIPTIONS = {
  Jobs: 'Headless runs of a public, inline pipeline (start, poll, stream).',
  Services: 'The workspace’s board services.',
  Tasks: 'Board tasks under a service (create, list, read, edit, start, stop, retry, stream).',
  Pipelines: 'The workspace’s pipelines (discover a pipelineId to start a task with).',
  Notifications:
    'The workspace’s human-actionable notifications (list, act on, or dismiss the run tails).',
  Decisions:
    'A run’s parked human decisions — requirement-review findings and implementation-fork choices — so a headless caller can drive the clarification loop instead of the run hanging. Answering requires a `decide`-scope key.',
  Debug:
    'A run’s recorded telemetry, for diagnosing one that went wrong: the model calls it made, the context each agent was provided, the searches it ran and how its infrastructure came up. Read-only (`read` scope), and every response’s size is bounded before the request is made.',
}

/** Human descriptions for the response status codes we emit (OpenAPI requires a description). */
const STATUS_DESCRIPTIONS = {
  200: 'Success',
  201: 'Created',
  202: 'Accepted — the run has started',
  204: 'No content',
  '4XX': 'Client error (validation, unauthorized, not found, conflict, rate limit)',
  '5XX': 'Server error',
}

/**
 * Rewrite `@valibot/to-json-schema`'s `#/$defs/<X>` refs to OpenAPI `#/components/schemas/<X>`, and
 * drop `$schema` and `$defs`.
 *
 * Dropping `$defs` is what keeps the emitted spec proportional to the surface. `toJsonSchema` copies
 * every definition it was handed into the `$defs` of EACH schema that references one, so a schema
 * inlined into ten operations carried ten copies of the whole component set — every new public DTO
 * cost ~10x its size in the committed file, which is churn a reviewer has to read past. Once the
 * refs above point into `#/components/schemas`, nothing resolves through `$defs` any more and it is
 * dead weight. `assertRefsResolve` below is the proof rather than the assumption: a `$ref` this drop
 * would strand fails generation instead of shipping a dangling pointer.
 */
function normalizeJsonSchema(node) {
  if (Array.isArray(node)) return node.map(normalizeJsonSchema)
  if (node && typeof node === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema' || k === '$defs') continue
      if (k === '$ref' && typeof v === 'string') {
        out[k] = v.replace('#/$defs/', '#/components/schemas/')
      } else {
        out[k] = normalizeJsonSchema(v)
      }
    }
    return out
  }
  return node
}

/**
 * Fail generation if any `$ref` in the document names a schema `components.schemas` does not carry.
 * This is what makes dropping `$defs` safe rather than hopeful: every ref must have been rewritten
 * into the components namespace and every target must actually be emitted, so a DTO that needs
 * hoisting shows up here (add it to {@link COMPONENT_SCHEMAS}) instead of as a spec a client
 * generator chokes on.
 */
function assertRefsResolve(doc) {
  const known = new Set(Object.keys(doc.components?.schemas ?? {}))
  const dangling = new Set()
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        const name = v.startsWith('#/components/schemas/') ? v.slice(21) : null
        if (name === null || !known.has(name)) dangling.add(v)
      } else walk(v)
    }
  }
  walk(doc.paths)
  walk(doc.components?.schemas)
  if (dangling.size > 0) {
    throw new Error(
      `OpenAPI document has unresolvable $refs: ${[...dangling].sort().join(', ')}. ` +
        'Hoist the schema into COMPONENT_SCHEMAS in scripts/generate-openapi.mjs.',
    )
  }
}

/** True when `v` is a route contract object (method + pathResolver + responses). */
function isApiContract(v) {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.method === 'string' &&
    typeof v.pathResolver === 'function' &&
    !!v.responsesByStatusCode
  )
}

/** A Standard-Schema value (Valibot schema) vs a marker like `ContractNoBody`. */
function isSchema(v) {
  return !!v && typeof v === 'object' && '~standard' in v
}

/** Resolve the contract's path to an OpenAPI path template (`/api/v1/services/{serviceId}/tasks`). */
function pathTemplate(contract) {
  const proxy = new Proxy({}, { get: (_t, key) => `{${String(key)}}` })
  return contract.pathResolver(proxy)
}

/** Path-parameter names embedded in a `{...}` templated path. */
function pathParamNames(template) {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
}

/** Recursively sort object keys so the emitted JSON is deterministic (stable diffs for the CI guard). */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortDeep(value[k])]),
    )
  }
  return value
}

export async function buildOpenApiDoc() {
  const contracts = await import(pathToFileURL(CONTRACTS_DIST).href)

  // Component schemas (named DTOs) + a reverse identity map (schema object → component name)
  // so an operation referencing a named DTO emits a `$ref` rather than re-inlining it.
  const defs = {}
  const nameBySchema = new Map()
  for (const [componentName, exportName] of Object.entries(COMPONENT_SCHEMAS)) {
    const schema = contracts[exportName]
    if (!schema)
      throw new Error(`Missing contracts export '${exportName}' for component '${componentName}'`)
    defs[componentName] = schema
    nameBySchema.set(schema, componentName)
  }
  const componentSchemas = normalizeJsonSchema(toJsonSchemaDefs(defs, { errorMode: 'ignore' }))

  const schemaRef = (schema) => {
    const name = nameBySchema.get(schema)
    if (name) return { $ref: `#/components/schemas/${name}` }
    return normalizeJsonSchema(toJsonSchema(schema, { errorMode: 'ignore', definitions: defs }))
  }

  const tags = new Set()
  const paths = {}

  for (const [exportName, contract] of Object.entries(contracts)) {
    if (!isApiContract(contract)) continue
    const template = pathTemplate(contract)
    if (!template.startsWith(API_PREFIX)) continue

    const operationId = exportName.replace(/Contract$/, '')
    const docs = OPERATION_DOCS[operationId] ?? { tag: 'Public API', summary: operationId }
    tags.add(docs.tag)

    const operation = {
      operationId,
      tags: [docs.tag],
      summary: docs.summary,
      responses: {},
    }
    if (docs.description) operation.description = docs.description

    const params = pathParamNames(template).map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }))
    // Query params (pagination cursors, page limits, status/`since` filters). Without these the
    // published spec documents a bounded list endpoint as if it took no arguments, so an external
    // integration reading it cannot discover how to page at all. One `in: 'query'` entry per
    // top-level key of the contract's query schema, carrying its description + constraints.
    if (isSchema(contract.requestQuerySchema)) {
      const query = normalizeJsonSchema(
        toJsonSchema(contract.requestQuerySchema, { errorMode: 'ignore', definitions: defs }),
      )
      const required = new Set(query.required ?? [])
      for (const [name, schema] of Object.entries(query.properties ?? {})) {
        params.push({ name, in: 'query', required: required.has(name), schema })
      }
    }
    if (params.length) operation.parameters = params

    if (isSchema(contract.requestBodySchema)) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: schemaRef(contract.requestBodySchema) } },
      }
    }

    for (const [code, schema] of Object.entries(contract.responsesByStatusCode)) {
      // `4xx`/`5xx` range keys → OpenAPI 3.1 `4XX`/`5XX`.
      const status = /^[45]xx$/.test(code) ? code.toUpperCase() : code
      const response = { description: STATUS_DESCRIPTIONS[status] ?? 'Response' }
      if (isSchema(schema)) {
        response.content = { 'application/json': { schema: schemaRef(schema) } }
      }
      operation.responses[status] = response
    }

    paths[template] ??= {}
    paths[template][contract.method] = operation
  }

  // The raw SSE routes that are NOT contracts (streaming Hono routes), documented by hand.
  tags.add('Jobs')
  paths[`${API_PREFIX}/jobs/{id}/events`] = {
    get: {
      operationId: 'streamPublicJobEvents',
      tags: ['Jobs'],
      summary: 'Stream a job (SSE)',
      description:
        'Server-sent events for a headless job run: `progress` frames until a terminal `done`/`error`/`stopped`/`timeout` event. Authenticated by the API key header.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'An event stream of job updates',
          content: { 'text/event-stream': { schema: { type: 'string' } } },
        },
        '4XX': {
          description: STATUS_DESCRIPTIONS['4XX'],
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
      },
    },
  }
  tags.add('Tasks')
  paths[`${API_PREFIX}/tasks/{taskId}/events`] = {
    get: {
      operationId: 'streamPublicTaskRun',
      tags: ['Tasks'],
      summary: 'Stream a task run (SSE)',
      description:
        'Server-sent events for a board task run: `progress` frames (the rich run projection) until a terminal `done`/`error` event, or a `timeout` when the connection cap is reached. Authenticated by the API key header.',
      parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'An event stream of run updates',
          content: { 'text/event-stream': { schema: { type: 'string' } } },
        },
        '4XX': {
          description: STATUS_DESCRIPTIONS['4XX'],
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
      },
    },
  }

  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'cat-factory Public API',
      version: API_VERSION,
      description:
        'The external, key-authenticated API (`/api/v1`). Authenticate every request with a public-API key: `Authorization: Bearer cf_live_<keyId>.<secret>`. Every call is scoped to the key’s workspace.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: '/', description: 'The deployment base URL' }],
    security: [{ bearerAuth: [] }],
    tags: [...tags].sort().map((name) => ({
      name,
      ...(TAG_DESCRIPTIONS[name] ? { description: TAG_DESCRIPTIONS[name] } : {}),
    })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'A public-API key of the form `cf_live_<keyId>.<secret>`.',
        },
      },
      schemas: componentSchemas,
    },
  }
  assertRefsResolve(doc)
  return sortDeep(doc)
}

/** Deterministic serialization used by both the writer and the CI guard. */
export function serializeOpenApiDoc(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`
}

async function main() {
  const doc = await buildOpenApiDoc()
  await writeFile(OPENAPI_PATH, serializeOpenApiDoc(doc), 'utf8')
  console.log(`Wrote ${OPENAPI_PATH}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
