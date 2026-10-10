// Signing and posting a webhook delivery, the way the platform does.
//
// Shared because two specs need a real card in the Durable Object and neither is about the
// delivery path: `gatekeeper.spec.ts` drives the inbox over `/rpc`, and `os.spec.ts` reads the
// same cards through a governed session. A second copy of the MAC would be a second thing to keep
// in step with `webhook/signature.ts`, and the copy that drifted would go on passing.

import { SELF } from 'cloudflare:test'

const ORIGIN = 'https://gatekeeper.example.com'

/** The suite Worker's own endpoint secret, as `vitest.config.ts` binds it. */
const WEBHOOK_SECRET = 'test-webhook-secret-0123456789ab'

/** The headers a signed delivery carries: the MAC is over `<timestamp>.<raw body>`. */
async function sign(rawBody: string, timestamp: number): Promise<Record<string, string>> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  )
  return {
    'content-type': 'application/json',
    'x-cat-factory-timestamp': String(timestamp),
    'x-cat-factory-signature': `v1=${[...new Uint8Array(mac)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')}`,
  }
}

/** Deliver one webhook the way the platform would, signature and all. */
export async function deliver(body: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(body)
  return SELF.fetch(`${ORIGIN}/webhook`, {
    method: 'POST',
    headers: await sign(raw, Date.now()),
    body: raw,
  })
}

/**
 * A parked-decision delivery. `decision_required` by default because that is the type an ordinary
 * approval gate raises; `merge_review` is the deliberate NOTICE and is asked for by name.
 *
 * The title is an override rather than a constant because it is AGENT-AUTHORED text on a rendered
 * surface: a spec about what an approver ends up reading has to be able to choose it.
 */
export function parkedCard(
  runId: string,
  cardId: string,
  type = 'decision_required',
  title = 'A run is waiting',
): Record<string, unknown> {
  return {
    deliveryId: `${cardId}-open`,
    sentAt: Date.now(),
    workspaceId: 'ws_1',
    runId,
    taskId: 'blk_4',
    notification: {
      id: cardId,
      type,
      status: 'open',
      title,
      body: 'The step finished and needs an answer.',
    },
  }
}

/** A run lifecycle delivery, the family a status Gadget reads instead of polling. */
export function runEvent(runId: string, event: string): Record<string, unknown> {
  return {
    deliveryId: `${runId}:${event}`,
    sentAt: Date.now(),
    workspaceId: 'ws_1',
    event,
    run: { id: runId, status: event === 'run.failed' ? 'failed' : 'running' },
  }
}
