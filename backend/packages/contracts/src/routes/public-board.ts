import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import {
  attachPublicTaskDocumentSchema,
  createPublicServiceSchema,
  detachPublicTaskDocumentSchema,
  publicAttachedDocumentListSchema,
  publicAttachedDocumentSchema,
  publicRepoListSchema,
  publicTaskDependencySchema,
} from '../public-board.js'
import { publicServiceSchema, publicTaskSchema } from '../public-api.js'
import { errorResponses, singleStringParam, withMinScope } from './_shared.js'

// ---------------------------------------------------------------------------
// Board PROVISIONING and the two task relationships that outlive a create call, on `/api/v1`.
//
// Their own file rather than more of `public-api.ts`, which had grown to carry the whole surface:
// these are one cohesive addition (what a headless deployment needs to SET UP and RELATE the board
// it drives, as opposed to what it needs to run one task) and they share a scope argument that is
// worth stating once.
//
// **Scope.** Creating and deleting a service are `admin`; the task-level writes are `write`.
//
// The split follows what each act CHANGES rather than how destructive it feels. Creating a service
// is board STRUCTURE, which is what `admin` already covers on this surface for keys and the
// outbound webhook, and it is the rung a provisioning integration holds anyway. Attaching a
// document, declaring an ordering: those edit ONE task the caller can already create, edit and
// start with a `write` key, so putting them a rung higher would mean handing an integration that
// files tickets a credential that can also merge pull requests and delete tasks.
//
// Where the two readings were close, the REVERSIBLE one wins (ADR 0034): a scope can be relaxed
// later and never tightened, because narrowing what a live key may do is a break however small.
// ---------------------------------------------------------------------------

const taskIdParams = singleStringParam('taskId')

// ---- provisioning: the repositories, and the services they back --------------

/**
 * List the repositories this workspace can back a service with.
 *
 * The discovery half of service creation, and what makes it usable with no browser: the create
 * takes a provider repo id, and nothing on this surface served one. `read` scope, like every other
 * discovery endpoint here (`/pipelines`, `/task-types`): it names what the workspace has already
 * connected, and an integration must be able to see what it is about to ask for without holding the
 * credential that could change it.
 */
export const listPublicReposContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/repos',
    responsesByStatusCode: { 200: publicRepoListSchema, ...errorResponses },
  }),
)

/**
 * Create a board service, optionally backed by a repository: the last act of board setup that had
 * no headless counterpart, so a deployment that could provision its own keys and enrol its own
 * webhook still had to open the app once to have anywhere to file work.
 *
 * Delegates to the SAME service methods the app's own "import a repository" button and drag-drop
 * call, so every guard holds identically: a whole-repo repository that already backs a service in
 * this account is MOUNTED here rather than duplicated, a monorepo must name its subdirectory, and a
 * subdirectory another service already claims is refused.
 */
export const createPublicServiceContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'post',
    pathResolver: () => '/api/v1/services',
    requestBodySchema: createPublicServiceSchema,
    responsesByStatusCode: { 201: publicServiceSchema, ...errorResponses },
  }),
)

/**
 * Delete a board service, its whole subtree and the run history under it: the inverse of the
 * create, and the act a headless deployment could not perform at all.
 *
 * The one board write whose absence forced a browser. Tearing a service down is ordinary
 * housekeeping for a caller that provisions boards (an environment rebuilt per test pass, a
 * repository retired, a frame raised against the wrong repository), and until this endpoint the
 * only door was the app's own, which no API key can reach: a key authenticates on `/api/v1`
 * alone. So a caller could create a service, fill it with work, and then had to ask a person to
 * clean it up.
 *
 * Delegates to the SAME teardown-then-remove sequence the app's delete uses, guard included: a
 * service holding UNFINISHED tasks is refused (422, `reason: 'service_has_unfinished_tasks'`)
 * rather than discarding in-flight work, so a caller that means it deletes those tasks first
 * (`DELETE /api/v1/tasks/{taskId}`, which stops a live run) and calls this again. `admin`, like
 * every destructive operation here.
 *
 * The frame is resolved on exactly the population `GET /api/v1/services` reports, so an ARCHIVED
 * one is a 404 here as it is absent there: archiving is the app's non-destructive alternative to
 * this call, and a surface that published neither the archive nor the restore has no business
 * deleting through one.
 */
export const deletePublicServiceContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'delete',
    requestPathParamsSchema: singleStringParam('serviceId'),
    pathResolver: ({ serviceId }) => `/api/v1/services/${serviceId}`,
    responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
  }),
)

// ---- task ordering ----------------------------------------------------------

/**
 * Declare that this task must wait for another one. Idempotent: an edge that already exists is
 * returned as-is rather than toggled off, which is what separates this from the app's own toggle
 * and what lets a provisioning integration re-run without inverting the graph it declared last time.
 */
export const addPublicTaskDependencyContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: taskIdParams,
    pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}/dependencies`,
    requestBodySchema: publicTaskDependencySchema,
    responsesByStatusCode: { 200: publicTaskSchema, ...errorResponses },
  }),
)

/** Drop a dependency edge. Idempotent, for the same reason the add is. */
export const removePublicTaskDependencyContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: taskIdParams,
    pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}/dependencies/remove`,
    requestBodySchema: publicTaskDependencySchema,
    responsesByStatusCode: { 200: publicTaskSchema, ...errorResponses },
  }),
)

// ---- a task's documents, after it exists -------------------------------------

/** The requirements documents attached to a task, in the order the agents read them. */
export const listPublicTaskDocumentsContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: taskIdParams,
    pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}/documents`,
    responsesByStatusCode: { 200: publicAttachedDocumentListSchema, ...errorResponses },
  }),
)

/**
 * Attach a requirements document to an EXISTING task: the same two forms creation takes, at the
 * moment a spec actually arrives.
 */
export const attachPublicTaskDocumentContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: taskIdParams,
    pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}/documents`,
    requestBodySchema: attachPublicTaskDocumentSchema,
    responsesByStatusCode: { 201: publicAttachedDocumentSchema, ...errorResponses },
  }),
)

/**
 * Detach a document from a task, naming it by the `(source, externalId)` pair the list serves.
 *
 * A POST rather than a `DELETE .../documents/{id}`: a document's identity is two values, one of
 * which is a free-form external id that is a path for some sources (`docs/adr/0001.md`), so
 * addressing it in a path segment would need escaping rules a caller has to get right to reach its
 * own document.
 */
export const detachPublicTaskDocumentContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: taskIdParams,
    pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}/documents/detach`,
    requestBodySchema: detachPublicTaskDocumentSchema,
    responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
  }),
)
