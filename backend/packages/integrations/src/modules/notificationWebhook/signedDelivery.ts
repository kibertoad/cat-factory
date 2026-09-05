import type { Clock, SecretCipher, UrlSafetyPolicy } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { DEFAULT_MAX_REDIRECTS, safeFetch } from '../shared/safe-fetch.js'
import { assertSafeNotificationWebhookUrl } from './webhookUrl.js'
import { signWebhookDelivery } from './webhookSignature.js'

// The one outbound-delivery core every registered webhook endpoint is driven through. All three
// families that POST to one — the notification cards, the run-lifecycle events and the
// platform-health alerts — share this rather than each carrying its own retry loop, because
// everything interesting about the delivery (the wall-clock budget, which failures are worth
// retrying, re-validating the URL on every redirect hop, the signature headers) is a property of
// the ENDPOINT, not of the payload. A second copy would be a second place to get the SSRF guard
// subtly wrong.
//
// A workspace registers SEVERAL endpoints, so the three families reach this through
// `fanOutSignedWebhook` rather than calling `postSignedWebhook` per endpoint themselves: the
// bounded concurrency, the shared wall-clock budget and the per-endpoint isolation are properties
// of the fan-out, and three hand-rolled copies of it is exactly the drift this file exists to
// prevent one layer down.

/** How many attempts one delivery gets, and how long to wait between them (exponential). */
const MAX_ATTEMPTS = 3
const BASE_RETRY_MS = 250

/** Give up on a single HTTP attempt after this long, so a black-holing endpoint can't hang us. */
const REQUEST_TIMEOUT_MS = 5000

/**
 * The ceiling on one EMISSION: a single delivery, or a whole fan-out across every subscribed
 * endpoint. This is the number that matters, and it is not the per-attempt timeout multiplied out.
 * The caller AWAITS it, so every millisecond spent here is latency added to the engine step that
 * produced the event, the very step that parks or settles a run. Three 5s attempts plus backoff
 * would let a dead receiver add ~15.8s, which the in-app and Slack channels never do.
 *
 * So the retry budget is a WALL-CLOCK deadline, not an attempt count: attempts stop as soon as the
 * remaining budget is gone, and each attempt's own timeout is clamped to what is left. Delivery is
 * best-effort by contract, so a receiver too slow to answer inside the budget is treated exactly
 * like one that failed.
 *
 * `fanOutSignedWebhook` hands the SAME deadline to every endpoint it drives rather than giving each
 * a fresh one, so registering a tenth webhook cannot turn a bounded wait into a ten-times-bounded
 * one. What that trades away is stated at the fan-out: past the budget, endpoints are reported as
 * not attempted rather than delivered late.
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

/**
 * How many deliveries may be in flight at once during a fan-out.
 *
 * Six because that is the Cloudflare Workers ceiling on simultaneous open connections per
 * invocation: a seventh `fetch` does not fail, it QUEUES, invisibly to the code that issued it. An
 * unbounded fan-out therefore does not buy parallelism past six, it only hides the queue, and the
 * hiding is the bug: each delivery's wall-clock budget starts when `postSignedWebhook` is entered,
 * so a queued endpoint spends its budget waiting for a connection and is then reported as a
 * failure it never actually attempted. Bounding the fan-out is what makes a reported failure mean
 * the receiver failed.
 *
 * Deliberately ONE number rather than a per-runtime one. Node has no such ceiling, but the cap is
 * ten endpoints, so the parallelism it would unlock is a second wave at most, and both facades
 * behaving identically is worth more than that: the fan-out's timing is what the conformance and
 * unit suites assert against.
 */
const MAX_CONCURRENT_DELIVERIES = 6

/** One delivery: where to POST, how to sign it, and the already-serialized body. */
interface SignedDeliveryRequest {
  url: string
  /** The endpoint's signing secret, still sealed. Null ⇒ deliver unsigned. */
  secretSealed: string | null
  /** The exact bytes to POST — the caller serializes, so the signature covers what is sent. */
  payload: string
  /** The epoch-ms stamp inside the payload; signed alongside it so a replay is detectable. */
  sentAt: number
  /**
   * Absolute epoch-ms ceiling for this delivery across all of its attempts. Omitted ⇒
   * {@link TOTAL_DELIVERY_BUDGET_MS} from now, which is the single-delivery case.
   *
   * A fan-out supplies its own so that N endpoints share ONE budget: the whole point of the number
   * is the latency the caller pays on a run's terminal path, and that is a property of the fan-out,
   * not of each delivery in it.
   */
  deadline?: number
}

/**
 * Raised for an endpoint the fan-out never got to before the shared budget ran out. Distinct from
 * a delivery error on purpose: "the receiver rejected us" and "we ran out of time to ask" need
 * different fixes, and reporting the second as the first would send an operator to debug a
 * receiver that was never contacted.
 */
export class WebhookDeliveryNotAttemptedError extends Error {
  constructor(endpointId: string) {
    super(
      `Webhook delivery to \`${endpointId}\` was not attempted: the fan-out spent its ${TOTAL_DELIVERY_BUDGET_MS}ms budget on earlier endpoints`,
    )
    this.name = 'WebhookDeliveryNotAttemptedError'
  }
}

/**
 * POST one signed delivery, retrying within the shared wall-clock budget. Throws the last error
 * when every attempt is spent — the CALLER decides what a failure means (both current callers
 * treat it as best-effort and report it through their observability hook).
 */
async function postSignedWebhook(
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

  const deadline = request.deadline ?? deps.clock.now() + TOTAL_DELIVERY_BUDGET_MS
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

/** One subscribed endpoint, as the fan-out needs it: where to POST and what to sign with. */
export interface SignedDeliveryTarget {
  id: string
  url: string
  secretSealed: string | null
}

/**
 * POST one already-composed body to EVERY subscribed endpoint, isolating each.
 *
 * Three properties are the whole reason this is a helper rather than a loop at each of the three
 * call sites:
 *
 * - **Concurrent, but BOUNDED.** The caller awaits the fan-out, so its cost is latency on the
 *   engine step that produced the event: the step that parks or settles a run. Running the
 *   deliveries in series would multiply the budget by the endpoint count, so a workspace would pay
 *   for enrolling a second integration in the latency of every run. Running them all at once is
 *   the opposite mistake, and a quieter one, because the concurrency past `MAX_CONCURRENT_DELIVERIES`
 *   is imaginary on the Worker (see that constant) while the budget it burns is real.
 * - **ONE wall-clock budget for the whole fan-out**, not one per endpoint. The number exists to
 *   bound what the caller waits for, and the caller waits for all of this, so a per-endpoint budget
 *   would let ten endpoints bound nothing at all. Each delivery is clamped to what is left when it
 *   actually starts, so its own retry loop still stops on time.
 * - **One failing receiver costs only its own delivery.** A rejected `Promise.all` would abandon
 *   nothing (the others are already in flight) but would report ONE failure for the batch, so a
 *   permanently broken endpoint would mask the health of every sibling. Each result is settled and
 *   reported on its own, naming the endpoint.
 *
 * An endpoint the budget never reached is reported too, as {@link WebhookDeliveryNotAttemptedError}
 * rather than as a delivery failure: it is a cap, and a cap records what it dropped. Silence there
 * would read as a delivery that succeeded, and a generic failure would read as a broken receiver.
 *
 * Never throws: every outcome goes to `onEndpointError` and the fan-out carries on, which is what
 * "best-effort" means for this transport.
 */
export async function fanOutSignedWebhook(
  deps: SignedDeliveryDependencies,
  targets: readonly SignedDeliveryTarget[],
  delivery: { payload: string; sentAt: number },
  onEndpointError: (error: unknown, target: SignedDeliveryTarget) => void,
): Promise<void> {
  const deadline = deps.clock.now() + TOTAL_DELIVERY_BUDGET_MS
  // A shared cursor rather than pre-sliced waves: a worker that finishes early picks up the next
  // endpoint immediately, so one slow receiver delays only itself and not the whole batch behind
  // it. With fixed waves, six healthy endpoints would all wait on the slowest of their six.
  let next = 0
  const deliverFrom = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      const target = targets[index]
      if (!target) return
      if (deps.clock.now() >= deadline) {
        onEndpointError(new WebhookDeliveryNotAttemptedError(target.id), target)
        continue
      }
      try {
        await postSignedWebhook(deps, {
          url: target.url,
          secretSealed: target.secretSealed,
          payload: delivery.payload,
          sentAt: delivery.sentAt,
          deadline,
        })
      } catch (error) {
        onEndpointError(error, target)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_DELIVERIES, targets.length) }, deliverFrom),
  )
}

/** Builds the redirect/size errors `safeFetch` raises, carrying its status for the log line. */
function makeWebhookError(status: number, message: string): Error {
  return new Error(`Webhook delivery failed (${status}): ${message}`)
}
