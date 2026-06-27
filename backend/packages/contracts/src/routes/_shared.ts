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
