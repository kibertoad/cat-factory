import { withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Shared building blocks for the route contracts (`routes/<domain>.ts`). The
// contracts are the single source of truth for path + method + request +
// response, consumed by the backend (`buildHonoRoute`) and the frontend client
// (`sendByApiContract`). See backend/packages/server for the wiring.
// ---------------------------------------------------------------------------

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
