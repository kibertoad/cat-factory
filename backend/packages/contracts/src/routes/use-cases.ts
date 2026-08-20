import { defineApiContract } from '@toad-contracts/valibot'
import {
  invokeUseCaseSchema,
  publicUseCaseListSchema,
  publicUseCaseSchema,
  useCaseInvocationSchema,
} from '../inline-use-cases.js'
import { errorResponses, singleStringParam, withMinScope } from './_shared.js'

// ---------------------------------------------------------------------------
// Route contracts for the public INLINE USE-CASE surface: the non-container half of `/api/v1`.
//
// A deployment registers its use cases in code on the app-owned `InlineUseCaseRegistry`; these
// three routes are how a wrapper over this API discovers them and runs one. The wire shapes and
// the reasoning behind them live in `../inline-use-cases.ts`; the engine side is
// `backend/docs/inline-use-cases.md`.
//
// The scope split follows the ladder the rest of the surface uses. Discovery is `read`, like every
// other "what may I do here" call: knowing which use cases exist is not invoking one, and an
// integration's startup check must work on whatever rung its key holds. INVOKING is `write`, not
// `admin`: it spends model tokens and returns text, and it creates no board row, starts no run and
// merges nothing — the same reasoning that puts `POST /api/v1/jobs` on `write`. Requiring `admin`
// would mean a content editor whose whole job is generating prose had to hold a key that also
// deletes services.
// ---------------------------------------------------------------------------

const useCaseIdParams = singleStringParam('useCaseId')

/**
 * The catalog: every use case this deployment has registered, with its parameters, the models it
 * may run on and the generation bounds an invocation may steer within.
 *
 * The read this surface exists for. Without it a wrapper's only route to the same knowledge is a
 * hard-coded copy of the deployment's own registration, which is a second source of truth that
 * drifts the first time an operator narrows a model list — and drifts SILENTLY, because the
 * wrapper keeps offering a choice the invocation now refuses.
 */
export const listPublicUseCasesContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/use-cases',
    responsesByStatusCode: { 200: publicUseCaseListSchema, ...errorResponses },
  }),
)

/**
 * One use case by id: the point read beside the catalog, so a wrapper holding a `useCaseId` (from
 * its own config, or from a form a user built earlier) can re-read the parameters and the current
 * model availability without paging the whole catalog to find it.
 */
export const getPublicUseCaseContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: useCaseIdParams,
    pathResolver: ({ useCaseId }) => `/api/v1/use-cases/${useCaseId}`,
    responsesByStatusCode: { 200: publicUseCaseSchema, ...errorResponses },
  }),
)

/**
 * Run the use case and answer with the generated text.
 *
 * SYNCHRONOUS, unlike `POST /api/v1/jobs`, and that is the feature rather than a shortcut: this is
 * one inline model call with no checkout, no container and no durable driver, so there is no state
 * for a caller to poll and a job id would be a second round-trip around a call that has already
 * finished. `/invocations` rather than a bare `POST /api/v1/use-cases/{id}`, so the URL names what
 * is being created and leaves the use case itself addressable as the resource it is.
 *
 * Refusals a caller acts on, all carrying `details.reason`: an unregistered id is `404`
 * `use_case_not_found`; parameters that do not satisfy the descriptors are `422`
 * `use_case_parameters_invalid` with every problem named at once; a model outside the use case's
 * own list is `422` `use_case_model_not_allowed`; a model this deployment cannot serve inline is
 * `503` `use_case_model_unavailable` (never a silent substitution — the narrowing is the point);
 * an exhausted workspace budget is `429` `budget_exhausted`; and a model that answers with no
 * usable text is `503` `use_case_empty_reply` rather than a 200 carrying an empty string.
 */
export const invokePublicUseCaseContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: useCaseIdParams,
    pathResolver: ({ useCaseId }) => `/api/v1/use-cases/${useCaseId}/invocations`,
    requestBodySchema: invokeUseCaseSchema,
    responsesByStatusCode: { 200: useCaseInvocationSchema, ...errorResponses },
  }),
)
