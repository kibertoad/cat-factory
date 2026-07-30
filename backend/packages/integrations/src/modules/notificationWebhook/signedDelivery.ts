import type { Clock, SecretCipher, UrlSafetyPolicy } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { DEFAULT_MAX_REDIRECTS, safeFetch } from '../shared/safe-fetch.js'
import { assertSafeNotificationWebhookUrl } from './webhookUrl.js'
import { signWebhookDelivery } from './webhookSignature.js'

// The one outbound-delivery core the workspace's registered webhook endpoint is driven through.
// Both families that POST to it — the notification cards and the run-lifecycle events — share
// this rather than each carrying its own retry loop, because everything interesting about the
// delivery (the wall-clock budget, which failures are worth retrying, re-validating the URL on
// every redirect hop, the signature headers) is a property of the ENDPOINT, not of the payload.
// A second copy would be a second place to get the SSRF guard subtly wrong.

/** How many attempts one delivery gets, and how long to wait between them (exponential). */
const MAX_ATTEMPTS = 3
const BASE_RETRY_MS = 250

/** Give up on a single HTTP attempt after this long, so a black-holing endpoint can't hang us. */
const REQUEST_TIMEOUT_MS = 5000

/**
 * The ceiling on ONE delivery across all of its attempts. This is the number that matters, and it
 * is not the per-attempt timeout multiplied out: the caller AWAITS the delivery, so every
 * millisecond spent here is latency added to the engine step that produced the event — the very
 * step that parks or settles a run. Three 5s attempts plus backoff would let a dead receiver add
 * ~15.8s, which the in-app and Slack channels never do.
 *
 * So the retry budget is a WALL-CLOCK deadline, not an attempt count: attempts stop as soon as the
 * remaining budget is gone, and each attempt's own timeout is clamped to what is left. Delivery is
 * best-effort by contract, so a receiver too slow to answer inside the budget is treated exactly
 * like one that failed.
 */
const TOTAL_DELIVERY_BUDGET_MS = 6000

/** The collaborators a signed delivery needs, independent of what is being delivered. */
export interface SignedDeliveryDependencies {
  secretCipher: SecretCipher
  clock: Clock
  /** HTTP transport (each runtime exposes a global `fetch`); injectable for tests. */
  fetchImpl?: typeof fetch
  /** Sleep between retries; injectable so tests don't spend real wall-clock on backoff. */
  sleep?: (ms: number) => Promise<void>
  /**
   * The deployment's widened URL guard for webhook endpoints, when one is configured
   * (`NOTIFICATION_WEBHOOK_ALLOW_URL_HOSTS` / `_ALLOW_HTTP_URLS`). Absent ⇒ the strict
   * public-https default: no private/internal hosts, no cloud-metadata endpoint.
   */
  urlSafetyPolicy?: UrlSafetyPolicy
}

/** One delivery: where to POST, how to sign it, and the already-serialized body. */
export interface SignedDeliveryRequest {
  url: string
  /** The endpoint's signing secret, still sealed. Null ⇒ deliver unsigned. */
  secretSealed: string | null
  /** The exact bytes to POST — the caller serializes, so the signature covers what is sent. */
  payload: string
  /** The epoch-ms stamp inside the payload; signed alongside it so a replay is detectable. */
  sentAt: number
}

/**
 * POST one signed delivery, retrying within the shared wall-clock budget. Throws the last error
 * when every attempt is spent — the CALLER decides what a failure means (both current callers
 * treat it as best-effort and report it through their observability hook).
 */
export async function postSignedWebhook(
  deps: SignedDeliveryDependencies,
  request: SignedDeliveryRequest,
): Promise<void> {
  const fetchImpl =
    deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'cat-factory',
  }
  if (request.secretSealed) {
    const secret = await deps.secretCipher.decrypt(request.secretSealed)
    Object.assign(headers, await signWebhookDelivery(secret, request.payload, request.sentAt))
  }

  // The endpoint is operator-supplied, and the body we are about to POST carries the workspace's
  // work descriptions signed with a deployment secret. So the URL is re-validated on EVERY
  // redirect hop through the shared SSRF seam: `startsWith('https://')` at registration only ever
  // vouched for the FIRST url, and a receiver is free to 302 that to the cloud-metadata endpoint.
  // `safeFetch` also strips the body and credential headers on a cross-origin hop, so a permitted
  // host cannot bounce the delivery to a different one.
  const assertSafe = (u: string) => assertSafeNotificationWebhookUrl(u, deps.urlSafetyPolicy)

  const deadline = deps.clock.now() + TOTAL_DELIVERY_BUDGET_MS
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Only back off if there is budget left to use afterwards — sleeping into the deadline
      // would burn the caller's latency and then not even attempt the retry it paid for.
      const backoff = BASE_RETRY_MS * 2 ** (attempt - 1)
      if (deps.clock.now() + backoff >= deadline) break
      await sleep(backoff)
    }
    // Clamp this attempt to whatever is left, so the TOTAL is bounded rather than the per-attempt
    // timeout multiplied by the attempt count.
    const remaining = deadline - deps.clock.now()
    if (remaining <= 0) break
    try {
      const response = await safeFetch(
        request.url,
        {
          method: 'POST',
          headers,
          body: request.payload,
          signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
        },
        assertSafe,
        makeWebhookError,
        DEFAULT_MAX_REDIRECTS,
        fetchImpl,
      )
      if (response.ok) return
      // A 4xx is the receiver saying "this request is wrong" — a bad secret, a rejected shape, a
      // revoked endpoint. Retrying cannot fix it and only multiplies the load, so give up now
      // and let the error hook report it. 5xx / network faults are transient: those retry.
      lastError = new Error(`Webhook endpoint responded ${response.status}`)
      if (response.status >= 400 && response.status < 500) break
    } catch (error) {
      // A blocked hop (`assertSafe` threw) is a CONFIGURATION fault, not a transient one:
      // retrying re-walks the same redirect chain to the same rejected target. Give up and let
      // the operator see it, exactly as with a 4xx.
      lastError = error
      if (error instanceof ValidationError) break
    }
  }
  throw lastError ?? new Error('Webhook delivery failed')
}

/** Builds the redirect/size errors `safeFetch` raises, carrying its status for the log line. */
function makeWebhookError(status: number, message: string): Error {
  return new Error(`Webhook delivery failed (${status}): ${message}`)
}
