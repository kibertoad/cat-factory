import { DEFAULT_MAX_SKEW_MS, type VerificationResult, verifyDelivery } from './signature.ts'

/** A verified request: its raw body, ready to parse. */
export type VerifiedRequest =
  | { ok: true; rawBody: string }
  | Extract<VerificationResult, { ok: false }>

/**
 * Verify a Fetch API `Request` (Workers, Deno, Bun, Hono, Node's undici). Reads the body ONCE, as
 * text, and verifies those exact bytes; the caller parses `rawBody` only after `ok` is true.
 */
export async function verifyRequest(
  request: Request,
  secret: string,
  options: { now?: number; maxSkewMs?: number } = {},
): Promise<VerifiedRequest> {
  const rawBody = await request.text()
  const verdict = await verifyDelivery(
    request.headers,
    rawBody,
    secret,
    options.now ?? Date.now(),
    options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS,
  )
  return verdict.ok ? { ok: true, rawBody } : verdict
}
