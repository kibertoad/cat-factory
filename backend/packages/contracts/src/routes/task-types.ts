import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import { taskTypeSuppressionListSchema } from '../task-types.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Per-workspace operation-suppression route contracts (a workspace admin hiding the reusable
// operations that board does not run; see `backend/docs/reusable-operations.md`). Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix. See
// TaskTypeSuppressionController in @cat-factory/server.
//
// The shape is the foundational-service suppression pair: a LIST that serves both halves at once
// (what is registered and what is hidden), and a suppress/restore pair keyed by the task type id.
// ---------------------------------------------------------------------------

const taskTypeParams = singleStringParam('taskType')

// A path param is interpolated RAW, as every sibling contract in this directory does, and the one
// place that must not be clever about is a `pathResolver`. It serves TWO callers: a client
// building a URL, and route REGISTRATION, which calls it with the literal placeholder `:taskType`.
// Percent-encoding there yields `%3AtaskType`, so the route registers as a fixed path that no
// request can match and every write 404s while the paramless read beside it keeps working.
// Nothing is lost by dropping it: a task-type id is `isNamespacedId`-validated (`ns:kind`, lower
// kebab), and `:` is a legal path character.

/**
 * Every registered custom task type with its suppression state, in registration order.
 *
 * Its own read, not a slice of the board snapshot, and that is the whole point: a suppressed type
 * is by construction absent from the snapshot's `customTaskTypes`, so nothing there could offer
 * the way back. Reads pass the admin gate, so a member can see what the board offers.
 */
export const listTaskTypeSuppressionsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/task-type-suppressions',
  responsesByStatusCode: { 200: taskTypeSuppressionListSchema, ...errorResponses },
})

/**
 * Hide one registered operation from this workspace. Idempotent; a `taskType` the deployment does
 * not register is a 404, so a typo cannot leave a tombstone that hides nothing.
 */
export const suppressTaskTypeContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: taskTypeParams,
  pathResolver: ({ taskType }) => `/task-type-suppressions/${taskType}`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: taskTypeSuppressionListSchema, ...errorResponses },
})

/**
 * Offer one operation on this workspace again (delete its tombstone). Idempotent, and deliberately
 * NOT gated on the type still being registered: a withdrawn registration must not leave a row only
 * a database edit could clear.
 */
export const restoreTaskTypeContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: taskTypeParams,
  pathResolver: ({ taskType }) => `/task-type-suppressions/${taskType}`,
  responsesByStatusCode: { 200: taskTypeSuppressionListSchema, ...errorResponses },
})
