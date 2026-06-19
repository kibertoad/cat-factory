// @cat-factory/server — the runtime-neutral HTTP layer shared by every deployment
// facade. This first slice hosts the cross-cutting primitives (logging, request
// helpers, validation envelope, error mapping, CORS policy); the controllers,
// middleware and the Hono app factory move here in subsequent steps.
export { logger, type Logger } from './observability/logger'
export { param } from './http/params'
export { jsonBody } from './http/validation'
export { handleError } from './http/errorHandler'
export { parseAllowedOrigins, resolveCorsOrigin } from './http/cors'
export { base64url, base64urlToBytes, pkcs8PemToDer, timingSafeEqual } from './crypto/encoding'
export {
  HmacSigner,
  TOKEN_AUDIENCE,
  type SessionPayload,
  type SessionUser,
  type TokenAudience,
} from './auth/signing'
