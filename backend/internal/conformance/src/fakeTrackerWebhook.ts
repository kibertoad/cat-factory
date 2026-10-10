import type {
  TaskSourceWebhookAdapter,
  TrackerWebhookDelivery,
  TrackerWebhookEvent,
} from '@cat-factory/kernel'

// A deterministic, network-free inbound-webhook adapter for {@link FakeTaskSourceProvider}, so the
// cross-runtime suite can drive the REAL receiver → gateway → service path on every facade.
//
// It deliberately reuses the production signature CONSTRUCTION (HMAC-SHA256 hex over the raw body,
// in a `sha256=`-prefixed header) rather than stubbing verification out: what the suite is pinning
// is that each facade mounts the route, bypasses the session gate for it, resolves the
// per-connection secret, and hands a verified event to its queue-or-inline seam. Faking the crypto
// would leave every one of those unproven while still passing.
//
// The PAYLOAD, by contrast, is the neutral event itself rather than a vendor shape: mapping
// Jira/Linear/GitHub payloads onto the neutral event is per-vendor logic with no runtime dimension,
// so it belongs in the adapters' own unit tests. Duplicating a vendor envelope here would test the
// fixture, not the facade.

/** The header the fake signs into, mirroring GitHub's `sha256=<hex>` scheme. */
export const FAKE_TRACKER_SIGNATURE_HEADER = 'x-fake-signature'

const PREFIX = 'sha256='

/**
 * Sign a delivery body exactly as the fake adapter verifies it, returning the headers to send.
 * Exported so a suite constructs a genuinely-valid delivery (and, by omitting/mangling it, a
 * genuinely-invalid one).
 */
export async function signFakeTrackerDelivery(
  secret: string,
  body: string,
): Promise<Record<string, string>> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  let hex = ''
  for (const byte of mac) hex += byte.toString(16).padStart(2, '0')
  return { [FAKE_TRACKER_SIGNATURE_HEADER]: `${PREFIX}${hex}` }
}

/** The fake provider's webhook capability. */
export const fakeTrackerWebhookAdapter: TaskSourceWebhookAdapter = {
  async verify(secret, delivery) {
    // Fail closed on an unconfigured secret, exactly like the real adapters: the receiver's
    // "no secret ⇒ 503" guard is asserted separately, and this must not paper over a regression
    // in it by accepting an empty key here.
    if (!secret) return false
    const presented = delivery.headers[FAKE_TRACKER_SIGNATURE_HEADER]
    if (!presented) return false
    const expected = await signFakeTrackerDelivery(secret, new TextDecoder().decode(delivery.raw))
    return presented === expected[FAKE_TRACKER_SIGNATURE_HEADER]
  },
  parse(delivery: TrackerWebhookDelivery): TrackerWebhookEvent | null {
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(delivery.raw))
      if (!value || typeof value !== 'object') return null
      const event = value as Partial<TrackerWebhookEvent>
      // An unrecognised shape maps to null, which the receiver ACKS — the same contract the real
      // adapters have for a delivery kind we don't consume.
      return event.kind === 'issue' || event.kind === 'comment'
        ? (event as TrackerWebhookEvent)
        : null
    } catch {
      return null
    }
  },
}
