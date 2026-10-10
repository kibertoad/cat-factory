// `@cat-factory/sdk` — the TypeScript client for the cat-factory public API (`/api/v1`).
//
// The models and the 38 operation methods are GENERATED from `docs/openapi.json` (itself
// generated from the Valibot route contracts), so they cannot drift from the deployment they
// talk to. The transport, errors and SSE framing are hand-written.

export { CatFactoryClient } from './client.ts'
export type { ClientOptions, RequestOptions } from './http.ts'
export { encodePathSegment, SDK_VERSION } from './http.ts'
export type { EventStream, StreamEvent } from './sse.ts'
export {
  type ApiErrorBody,
  CatFactoryApiError,
  CatFactoryConflictError,
  CatFactoryConnectionError,
  CatFactoryCredentialRequiredError,
  CatFactoryDecodeError,
  CatFactoryError,
  CatFactoryForbiddenError,
  CatFactoryNotFoundError,
  CatFactoryPaginationError,
  CatFactoryRateLimitedError,
  CatFactoryServerError,
  CatFactoryTimeoutError,
  CatFactoryUnauthorizedError,
  CatFactoryValidationError,
} from './errors.ts'

// Every wire model (plus each enum's `*_VALUES` list), the resource classes, and the
// per-operation query-parameter shapes. `export *` carries types and values alike.
export * from './models.generated.ts'
export * from './operations.generated.ts'
