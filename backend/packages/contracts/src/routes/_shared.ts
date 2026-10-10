import { withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import type { PublicApiScope } from '../public-api-keys.js'

// ---------------------------------------------------------------------------
// Shared building blocks for the route contracts (`routes/<domain>.ts`). The
// contracts are the single source of truth for path + method + request +
// response, consumed by the backend (`buildHonoRoute`) and the frontend client
// (`sendByApiContract`). See backend/packages/server for the wiring.
// ---------------------------------------------------------------------------

/**
 * Attach the public-API scope FLOOR to a `/api/v1` route contract: the least key rung the route
 * admits (`public-api.md`, "Pick the right scope"). Declared on the contract so the three readers
 * of the same fact cannot drift: the controller enforces `contract.minScope`, the OpenAPI
 * generator stamps it as `x-min-scope` (and REFUSES a public contract without one), and the
 * generated SDK projections carry it as policy metadata.
 *
 * This is enforcement, not documentation: lowering an annotation lowers the gate, so review a
 * `minScope` diff exactly like a permission change. It is also only the STATIC floor. A handler
 * may still escalate at request time (starting a pipeline that can park requires `decide`), and
 * that dynamic half stays in the handler.
 */
export function withMinScope<const TScope extends PublicApiScope, TContract extends object>(
  minScope: TScope,
  contract: TContract,
): TContract & { readonly minScope: TScope } {
  return Object.assign(contract, { minScope } as const)
}

/**
 * Declare that a `/api/v1` route reads the personal-unlock header (`PERSONAL_PASSWORD_HEADER`):
 * the password that lets a key BOUND to a user unlock that user's own subscription for this call.
 *
 * It rides the contract for the same reason `minScope` does. The header is a real request input,
 * and the published surface is generated from these contracts with no hand-editing, so a route
 * that reads a header no contract declares is an input the spec cannot show and the four SDKs
 * cannot document: a caller discovers it by getting a 428 and reading prose. Marked here, the
 * OpenAPI generator emits it as an optional header parameter per operation.
 *
 * Optional on every route that takes it, always: a poolable run needs no unlock, and an unbound
 * key can use none, so the header is required only by the specific condition the 428 names.
 */
export function withPersonalUnlock<TContract extends object>(
  contract: TContract,
): TContract & { readonly personalUnlock: true } {
  return Object.assign(contract, { personalUnlock: true } as const)
}

/**
 * The error envelope every controller emits, produced by the shared `handleError`
 * (domain errors) and the contract request-validator (`{ code: 'validation' }`).
 * `details`/`issues` are the optional extras those two paths attach.
 */
export const errorResponseSchema = v.object({
  error: v.object({
    code: v.string(),
    message: v.string(),
    details: v.optional(v.unknown()),
    issues: v.optional(
      v.array(
        v.object({
          path: v.optional(v.string()),
          message: v.string(),
        }),
      ),
    ),
  }),
})
export type ErrorResponse = v.InferOutput<typeof errorResponseSchema>

/**
 * Spread into a contract's `responsesByStatusCode` so every inline non-2xx return
 * (`signInRequired` 401, capability-guard 503, …) and every thrown `DomainError`
 * routed through `handleError` is typed for the handler and validated by the client.
 * Exact success codes stay tight; these range keys catch the error halves.
 */
export const errorResponses = {
  '4xx': errorResponseSchema,
  '5xx': errorResponseSchema,
} as const

/**
 * A path-params schema for a single string segment:
 * `singleStringParam('blockId')` ≡ `withObjectKeys(v.object({ blockId: v.string() }))`.
 * Collapses the one-key param schemas every route file otherwise re-declares. The mapped
 * type over the single literal key preserves exact per-key typing (`{ blockId: string }`,
 * not a widened `Record<string, string>`), so the handler's `c.req.valid('param')` and the
 * client's `pathParams` stay as precise as the inline form.
 */
export function singleStringParam<const K extends string>(key: K) {
  return withObjectKeys(v.object({ [key]: v.string() } as { [P in K]: v.StringSchema<undefined> }))
}
