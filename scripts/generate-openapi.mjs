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
// Bump this only when the `/api/v1` contract itself changes in a versioned way.
const API_VERSION = '1.0.0'

/**
 * Named DTOs hoisted into `components.schemas` (so client codegen gets named types and
 * shared schemas aren't inlined N times): OpenAPI component name → the exported Valibot
 * schema's name in `@cat-factory/contracts`.
 */
const COMPONENT_SCHEMAS = {
  ErrorResponse: 'errorResponseSchema',
  PublicJob: 'publicJobSchema',
  InitiativeAccepted: 'initiativeAcceptedSchema',
  CreateInitiativeJob: 'createInitiativeJobSchema',
  PublicService: 'publicServiceSchema',
  PublicServiceList: 'publicServiceListSchema',
  PublicTask: 'publicTaskSchema',
  PublicTaskList: 'publicTaskListSchema',
  CreatePublicTask: 'createPublicTaskSchema',
  StartPublicTask: 'startPublicTaskSchema',
  UpdatePublicTask: 'updatePublicTaskSchema',
  PublicRun: 'publicRunSchema',
  PublicPipeline: 'publicPipelineSchema',
  PublicPipelineList: 'publicPipelineListSchema',
  Notification: 'notificationSchema',
  PublicNotificationList: 'publicNotificationListSchema',
  // Parked decisions. `PublicDecisionList` is the response of ALL eight decision routes, and it
  // transitively carries the full finding + fork-option shapes — hoisting it (and the members of
  // its variant) keeps the spec from inlining ~21KB per operation.
  PublicReviewFinding: 'publicReviewFindingSchema',
  PublicRequirementsDecision: 'publicRequirementsDecisionSchema',
  PublicForkDecision: 'publicForkDecisionSchema',
  PublicDecision: 'publicDecisionSchema',
  PublicDecisionList: 'publicDecisionListSchema',
  PublicReplyFinding: 'publicReplyFindingSchema',
  PublicSetFindingStatus: 'publicSetFindingStatusSchema',
  PublicIncorporate: 'publicIncorporateSchema',
  PublicResolveExceeded: 'publicResolveExceededSchema',
  PublicChooseFork: 'publicChooseForkSchema',
}

/** Per-operation docs, keyed by operationId (the exported contract const name minus `Contract`). */
const OPERATION_DOCS = {
  createInitiativeJob: {
    tag: 'Initiatives',
    summary: 'Start an initiative-breakdown run',
    description:
      'Start a public, inline pipeline headlessly against a supplied brief. Returns a job id to poll or stream. Nothing is pushed to GitHub.',
  },
  getPublicJob: {
    tag: 'Initiatives',
    summary: 'Get an initiative job',
    description:
      'Poll a headless initiative run started by this key: its status and, once finished, its result.',
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
      'Read a task’s current lifecycle status, run progress, execution id, and PR URL (once one exists).',
  },
  startPublicTask: {
    tag: 'Tasks',
    summary: 'Start (run) a task',
    description:
      'Start a task’s pipeline. Uses the request’s pipelineId, else the task’s pinned pipeline. A task on an individual-usage model cannot be started through the API (no headless personal-credential unlock).',
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
  cancelPublicJob: {
    tag: 'Initiatives',
    summary: 'Cancel an initiative job',
    description:
      'Stop a headless initiative run, freeing its concurrency slot. Idempotent — an already-finished job is returned as-is. Use this to abandon a run parked on a decision you do not intend to answer.',
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
}

/** Descriptions for the operation tags (groups). */
const TAG_DESCRIPTIONS = {
  Initiatives: 'Headless initiative-breakdown runs (start, poll, stream).',
  Services: 'The workspace’s board services.',
  Tasks: 'Board tasks under a service (create, list, read, edit, start, stop, retry, stream).',
  Pipelines: 'The workspace’s pipelines (discover a pipelineId to start a task with).',
  Notifications:
    'The workspace’s human-actionable notifications (list, act on, or dismiss the run tails).',
  Decisions:
    'A run’s parked human decisions — requirement-review findings and implementation-fork choices — so a headless caller can drive the clarification loop instead of the run hanging. Answering requires a `decide`-scope key.',
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

/** Rewrite `@valibot/to-json-schema`'s `#/$defs/<X>` refs to OpenAPI `#/components/schemas/<X>`, and drop `$schema`. */
function normalizeJsonSchema(node) {
  if (Array.isArray(node)) return node.map(normalizeJsonSchema)
  if (node && typeof node === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema') continue
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
  tags.add('Initiatives')
  paths[`${API_PREFIX}/jobs/{id}/events`] = {
    get: {
      operationId: 'streamPublicJobEvents',
      tags: ['Initiatives'],
      summary: 'Stream an initiative job (SSE)',
      description:
        'Server-sent events for a headless initiative run: `progress` frames until a terminal `done`/`error`/`stopped`/`timeout` event. Authenticated by the API key header.',
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
