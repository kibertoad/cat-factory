import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import {
  createHeadlessPublicApiKeySchema,
  createPublicApiKeySchema,
  createdPublicApiKeySchema,
  HEADLESS_KEY_MINT_SCOPE,
  publicApiKeyListResultSchema,
} from '../public-api-keys.js'
import { notificationSchema } from '../notifications.js'
import {
  createPublicJobSchema,
  createPublicTaskSchema,
  listPublicJobsQuerySchema,
  listPublicServiceTasksQuerySchema,
  publicJobAcceptedSchema,
  publicIdentitySchema,
  publicJobListSchema,
  publicJobSchema,
  publicNotificationListSchema,
  publicPipelineListSchema,
  publicRunSchema,
  publicServiceListSchema,
  publicTaskListSchema,
  publicTaskSchema,
  publicUsageSchema,
  startPublicTaskSchema,
  updatePublicTaskSchema,
} from '../public-api.js'
import { publicTaskTypeListSchema } from '../public-task-types.js'
import { errorResponses, singleStringParam, withMinScope } from './_shared.js'

// ---------------------------------------------------------------------------
// Public-API route contracts. Two surfaces:
//
//  1. Key management — session-authed, mounted under `/workspaces/:workspaceId`
//     (so paths are relative). A workspace owner mints/lists/revokes the keys an
//     external system will present. Note the path is `/public-api-keys` — the bare
//     `/api-keys` is the direct-provider (outbound) key pool.
//
//  2. The external surface — `/api/v1/*`, authenticated in-controller by the
//     public-API key (not the session gate), scoped to the key's workspace.
// ---------------------------------------------------------------------------

const idParams = singleStringParam('id')
const keyIdParams = singleStringParam('keyId')
const serviceIdParams = singleStringParam('serviceId')
const taskIdParams = singleStringParam('taskId')

// ---- key management (relative to `/workspaces/:workspaceId`) ---------------

export const listPublicApiKeysContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/public-api-keys',
  responsesByStatusCode: { 200: publicApiKeyListResultSchema, ...errorResponses },
})

export const createPublicApiKeyContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/public-api-keys',
  requestBodySchema: createPublicApiKeySchema,
  responsesByStatusCode: { 201: createdPublicApiKeySchema, ...errorResponses },
})

export const revokePublicApiKeyContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: idParams,
  pathResolver: ({ id }) => `/public-api-keys/${id}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- the external `/api/v1` surface (absolute paths, key-authenticated) ----

/**
 * Start a headless job: run a public, inline pipeline against a supplied brief. Lives at
 * `POST /api/v1/jobs` so the whole job lifecycle (create, list, get, cancel, stream) shares one
 * resource root; the create used to sit apart at `POST /api/v1/initiatives`, which split the
 * resource across two path roots for no reason a caller could see.
 */
export const createPublicJobContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    pathResolver: () => '/api/v1/jobs',
    requestBodySchema: createPublicJobSchema,
    responsesByStatusCode: { 202: publicJobAcceptedSchema, ...errorResponses },
  }),
)

/**
 * List the workspace's headless jobs (newest first, keyset-paginated). Scoped to the
 * runs THIS surface created — an internal-anchored run — exactly like the single-job read, so an
 * external key can never enumerate the workspace's ordinary board runs.
 */
export const listPublicJobsContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/jobs',
    requestQuerySchema: listPublicJobsQuerySchema,
    responsesByStatusCode: { 200: publicJobListSchema, ...errorResponses },
  }),
)

export const getPublicJobContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: idParams,
    pathResolver: ({ id }) => `/api/v1/jobs/${id}`,
    responsesByStatusCode: { 200: publicJobSchema, ...errorResponses },
  }),
)

/**
 * Cancel a headless job run. The escape hatch that makes admitting a PARKING pipeline
 * safe (see `backend/docs/adr/0047-headless-clarification-loop.md`, D1): a parked run waits for a
 * human indefinitely and holds one of the workspace's in-flight job slots, so a caller
 * that decides not to answer must be able to free it. Idempotent — a run already terminal comes
 * back as-is. Board tasks have had `POST /api/v1/tasks/:taskId/stop` all along; this is its
 * counterpart on the jobs surface.
 */
export const cancelPublicJobContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: idParams,
    pathResolver: ({ id }) => `/api/v1/jobs/${id}/cancel`,
    requestBodySchema: ContractNoBody,
    responsesByStatusCode: { 200: publicJobSchema, ...errorResponses },
  }),
)

// ---- basic board workloads: services + tasks (key-authenticated) -----------

/** List the workspace's services (board service frames). */
export const listPublicServicesContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/services',
    responsesByStatusCode: { 200: publicServiceListSchema, ...errorResponses },
  }),
)

/** Create a task under a service. */
export const createPublicTaskContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: serviceIdParams,
    pathResolver: ({ serviceId }) => `/api/v1/services/${serviceId}/tasks`,
    requestBodySchema: createPublicTaskSchema,
    responsesByStatusCode: { 201: publicTaskSchema, ...errorResponses },
  }),
)

/**
 * List a service's tasks (the whole subtree — tasks under the frame and its modules), bounded
 * and keyset-paginated with an optional status filter. Ordered by the stable task id, which is
 * deterministic but NOT chronological (see `listPublicServiceTasksQuerySchema`).
 */
export const listPublicServiceTasksContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: serviceIdParams,
    requestQuerySchema: listPublicServiceTasksQuerySchema,
    pathResolver: ({ serviceId }) => `/api/v1/services/${serviceId}/tasks`,
    responsesByStatusCode: { 200: publicTaskListSchema, ...errorResponses },
  }),
)

/** Get a task's status. */
export const getPublicTaskContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: taskIdParams,
    pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}`,
    responsesByStatusCode: { 200: publicTaskSchema, ...errorResponses },
  }),
)

/** Start (run) a task. */
export const startPublicTaskContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: taskIdParams,
    pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}/start`,
    requestBodySchema: startPublicTaskSchema,
    responsesByStatusCode: { 202: publicTaskSchema, ...errorResponses },
  }),
)

/** Edit a task's authored inputs: title, description and its per-type `fields` bag (pre-start edits). */
export const updatePublicTaskContract = withMinScope(
  'write',
  defineApiContract({
    method: 'patch',
    requestPathParamsSchema: taskIdParams,
    pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}`,
    requestBodySchema: updatePublicTaskSchema,
    responsesByStatusCode: { 200: publicTaskSchema, ...errorResponses },
  }),
)

/** Stop a task's in-flight run (records a `cancelled` terminal state, leaving it retryable). */
export const stopPublicTaskContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: taskIdParams,
    pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}/stop`,
    requestBodySchema: ContractNoBody,
    responsesByStatusCode: { 200: publicTaskSchema, ...errorResponses },
  }),
)

/** Retry a task's failed run. */
export const retryPublicTaskContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: taskIdParams,
    pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}/retry`,
    requestBodySchema: ContractNoBody,
    responsesByStatusCode: { 202: publicTaskSchema, ...errorResponses },
  }),
)

/** Read a task's rich run projection (per-step status, subtasks, failure, PR branch). */
export const getPublicRunContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: taskIdParams,
    pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}/run`,
    responsesByStatusCode: { 200: publicRunSchema, ...errorResponses },
  }),
)

/** Delete a task (and its run history). Destructive — requires an `admin`-scoped key. */
export const deletePublicTaskContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'delete',
    requestPathParamsSchema: taskIdParams,
    pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}`,
    responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
  }),
)

// ---- pipeline discovery (key-authenticated) --------------------------------

/**
 * List the task types this key's workspace may create, with the form each accepts. The discovery
 * half of `createPublicTaskSchema.fields`: a caller reads the descriptors here and fills them
 * there, rather than guessing at a shape the create call would then refuse.
 */
export const listPublicTaskTypesContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/task-types',
    responsesByStatusCode: { 200: publicTaskTypeListSchema, ...errorResponses },
  }),
)

/** List the workspace's pipelines (id/name/steps + a headless-startable flag). */
export const listPublicPipelinesContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/pipelines',
    responsesByStatusCode: { 200: publicPipelineListSchema, ...errorResponses },
  }),
)

// ---- notification inbox: merge / confirm / retry the run tails -------------
// The external counterparts of the SPA's notification-inbox operations, scoped to the
// key's workspace. They complete the task lifecycle: `act` resolves a human-gated tail
// (merge a `merge_review` / `pipeline_complete` PR, retry a `ci_failed` / `test_failed`
// run), `dismiss` waves a card off. `act` performs a real GitHub merge, so it is the
// top of the scope ladder (`admin`); `dismiss` is `write`; the list is `read`.
//
// Recording the reviewer EFFORT a merge took does not sit at that top rung, and is not on this
// route at all: `POST /api/v1/merge-records/:recordId/effort` (`write`, see
// `./public-merge-evidence.ts`) is where a headless caller tags a landed pull request, before or
// after the `act` that merged it.

/** List the workspace's OPEN notifications (the inbox). */
export const listPublicNotificationsContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/notifications',
    responsesByStatusCode: { 200: publicNotificationListSchema, ...errorResponses },
  }),
)

/**
 * Act on a notification (run its typed side-effect, then resolve it). Requires an `admin` key.
 *
 * Body-LESS, deliberately, where the session-authed twin carries an optional `reviewEffort`
 * (`routes/notifications.ts`). Every emitter renders a request body as a REQUIRED positional
 * parameter, so giving this route the tag field would rewrite `act(id)` as `act(id, body)` in
 * four published clients: a compile break for every existing caller, which is exactly what
 * CLAUDE.md's "the public API does not break" refuses. A headless caller records the tag through
 * `POST /api/v1/merge-records/:recordId/effort` instead (`./public-merge-evidence.ts`), which is
 * a rung LOWER than this route rather than a workaround for it: tagging a landed pull request
 * merges nothing.
 */
export const actPublicNotificationContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: idParams,
    pathResolver: ({ id }) => `/api/v1/notifications/${id}/act`,
    requestBodySchema: ContractNoBody,
    responsesByStatusCode: { 200: notificationSchema, ...errorResponses },
  }),
)

/** Dismiss a notification without acting on it. */
export const dismissPublicNotificationContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: idParams,
    pathResolver: ({ id }) => `/api/v1/notifications/${id}/dismiss`,
    requestBodySchema: ContractNoBody,
    responsesByStatusCode: { 200: notificationSchema, ...errorResponses },
  }),
)

// ---- key introspection (`read` scope) --------------------------------------

/**
 * What the calling key is and what it may do.
 *
 * `read` scope, which is the floor: an integration's first call at startup is the one that must
 * work whatever rung it holds, and gating self-description behind a higher scope would make the
 * check itself the thing that needs a wider key. It reveals nothing a caller does not already
 * have — the key id is the non-secret half of the token it just presented, and the workspace and
 * scope are properties of the credential in its own hand.
 *
 * Before this, "can I do X" was answerable only by attempting X and reading the `403`, which for
 * a destructive operation is not a check at all.
 */
export const getPublicIdentityContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/me',
    responsesByStatusCode: { 200: publicIdentitySchema, ...errorResponses },
  }),
)

// ---- usage & spend (the external dashboard read) ---------------------------

/**
 * The workspace's usage for the current billing period: the metered budget position plus the
 * per-model breakdown behind it. Workspace-scoped by construction (the aggregate names no
 * resource ids and no account/user dimension), so `read` is the whole scope story.
 */
export const getPublicUsageContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/usage',
    responsesByStatusCode: { 200: publicUsageSchema, ...errorResponses },
  }),
)

// ---- headless key provisioning (`admin` scope) -----------------------------
// The external counterpart of the session-authed `/public-api-keys` routes above, and the same
// class of gap the outbound webhook had: a deployment whose operator is headless could reach
// every part of this API except the act of GETTING a key, so an integration that provisions
// per-tenant or per-environment credentials had to route a human through the app for each one.
//
// Two bounds make it safe to offer, both stated where they are enforced: a minted key can never
// reach the `admin` rung provisioning itself requires (so the mint chain is one link long), and
// revoking a key revokes everything it minted (so a leaked provisioning key cannot outlive its
// own revocation). See `HEADLESS_MINTABLE_SCOPES`.

/** List the workspace's live keys: metadata only; a secret is never readable back. */
export const listPublicKeysContract = withMinScope(
  HEADLESS_KEY_MINT_SCOPE,
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/keys',
    responsesByStatusCode: { 200: publicApiKeyListResultSchema, ...errorResponses },
  }),
)

/**
 * Mint a key for the calling key's own workspace, returning the raw secret exactly once.
 * Omitting `scope` mints a `write` key. `admin` is refused: see the section note above.
 */
export const createPublicKeyContract = withMinScope(
  HEADLESS_KEY_MINT_SCOPE,
  defineApiContract({
    method: 'post',
    pathResolver: () => '/api/v1/keys',
    requestBodySchema: createHeadlessPublicApiKeySchema,
    responsesByStatusCode: { 201: createdPublicApiKeySchema, ...errorResponses },
  }),
)

/**
 * Revoke a key, and with it every key that key minted. Idempotent.
 *
 * It may name the CALLING key, which is how a provisioning credential retires itself at the end of
 * a run: the request is already authorized by the time it lands, and the cascade takes the keys it
 * handed out with it. Note which key that can be: revoking needs `admin`, and `admin` is not
 * mintable here, so the key that retires itself is always one a person minted in the app. A key
 * provisioned over this API cannot revoke ITSELF (or anything else); its holder hands it back by
 * asking whoever provisioned it, or the provisioner revokes itself and takes it along.
 */
export const revokePublicKeyContract = withMinScope(
  HEADLESS_KEY_MINT_SCOPE,
  defineApiContract({
    method: 'delete',
    requestPathParamsSchema: keyIdParams,
    pathResolver: ({ keyId }) => `/api/v1/keys/${keyId}`,
    responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
  }),
)
