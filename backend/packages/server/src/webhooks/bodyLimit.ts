import { bodyLimit } from 'hono/body-limit'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../http/env.js'

// A shared body-size backstop for the PUBLIC, UNAUTHENTICATED webhook receivers
// (`/github/webhooks`, `/vcs/:provider/webhooks`). HMAC-over-body verification inherently
// needs the whole body buffered before it can be checked, so an anonymous caller could
// otherwise pin memory up to the platform request limit (CF ~100 MB, Node's default) before
// the signature is ever validated. `bodyLimit` counts bytes as the stream is read, so a body
// with no Content-Length (chunked) or a spoofed header still can't buffer past the ceiling.
// GitHub caps its own deliveries at 25 MB; GitLab's are smaller, so one shared ceiling covers
// both with headroom.

/** Ceiling on a buffered webhook delivery, before HMAC verification. */
const MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024

/**
 * The `bodyLimit` middleware for a webhook route: reject an oversized delivery with 413.
 * `maxSize` is overridable only so the guard is cheaply testable; both callers use the default.
 */
export function webhookBodyLimit(maxSize = MAX_WEBHOOK_BODY_BYTES): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize,
    onError: (c) =>
      c.json({ error: { code: 'too_large', message: 'Webhook payload exceeds size limit' } }, 413),
  })
}
