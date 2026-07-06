import { wrapLanguageModel } from 'ai'
import type { LanguageModel, LanguageModelMiddleware } from 'ai'
import type { SubscriptionVendor } from '@cat-factory/contracts'
import type { ModelProvider, ModelRef } from '@cat-factory/kernel'
import { ALL_SUBSCRIPTION_VENDORS, subscriptionVendorForRef } from '@cat-factory/kernel'
import { type PermitRelease, Semaphore } from './semaphore.js'

// Bounds how many INLINE LLM calls to a subscription/shared-pool vendor run at once, so a
// burst of inline generations (a consensus fan-out, the requirements recommendation writer,
// a sandbox sweep) can't overwhelm a vendor. This is the inline (`ModelProvider`) path only;
// the container/harness path reaches vendors through the LLM proxy and is out of scope.
//
// Only the five subscription vendors (`claude`/`codex`/`glm`/`kimi`/`deepseek`) are capped —
// a call keyed by `subscriptionVendorForRef(ref)`. Everything else (your own OpenAI/Anthropic
// API keys, Cloudflare, local runners) passes through uncapped. On Node/Worker an inline
// subscription ref is degraded to a pool/API-key provider BEFORE it reaches `resolve`, so the
// cap bites mainly in local mode (the prewarmed-container inline subscription backend keeps the
// ref); on Node/Worker it is a harmless wired pass-through.
//
// The limiter's counters are in-process, so it bounds concurrency within one Node process or
// one Worker isolate — which is exactly the scope of a single inline fan-out. Global,
// cross-replica/cross-isolate rate limiting is deliberately out of scope (see
// backend/docs/concurrency-and-redis.md).

/** Per-vendor max in-flight inline calls. A vendor absent (or ≤ 0) is uncapped. */
export type VendorConcurrencyLimits = Partial<Record<SubscriptionVendor, number>>

/** Default cap applied per subscription vendor when a facade doesn't override it. */
const DEFAULT_SUBSCRIPTION_INLINE_CONCURRENCY = 3

/** Env var for the default cap; `${VAR}_<VENDOR>` (e.g. `_CLAUDE`) overrides one vendor. */
const SUBSCRIPTION_INLINE_CONCURRENCY_ENV = 'LLM_SUBSCRIPTION_MAX_CONCURRENCY'

/**
 * Parse an env value into a cap. A numeric value clamps to `>= 0`, so any non-positive number
 * (`0`, `-1`, …) means "uncapped" — an operator who writes `-1` for "no limit" gets exactly
 * that rather than a silent fallback to the default cap. A blank or non-numeric value returns
 * `undefined` so the caller falls back to the layer below it (per-vendor → global → default).
 */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : undefined
}

/**
 * Read the per-vendor caps from the environment (shared by every facade so the two runtimes
 * parse identically). `LLM_SUBSCRIPTION_MAX_CONCURRENCY` sets the default cap for all five
 * subscription vendors (falls back to {@link DEFAULT_SUBSCRIPTION_INLINE_CONCURRENCY}); a
 * `LLM_SUBSCRIPTION_MAX_CONCURRENCY_<VENDOR>` (e.g. `_KIMI`) overrides that ONE vendor and always
 * wins (specific beats general). Any value `<= 0` is uncapped, so setting the default to `0`
 * uncaps every vendor that has no explicit per-vendor override; to disable limiting entirely,
 * leave the per-vendor overrides unset (or `0`) as well.
 */
function vendorConcurrencyLimitsFromEnv(
  get: (key: string) => string | undefined,
): VendorConcurrencyLimits {
  const base =
    parseLimit(get(SUBSCRIPTION_INLINE_CONCURRENCY_ENV)) ?? DEFAULT_SUBSCRIPTION_INLINE_CONCURRENCY
  const limits: VendorConcurrencyLimits = {}
  for (const vendor of ALL_SUBSCRIPTION_VENDORS) {
    limits[vendor] =
      parseLimit(get(`${SUBSCRIPTION_INLINE_CONCURRENCY_ENV}_${vendor.toUpperCase()}`)) ?? base
  }
  return limits
}

/** Build a {@link VendorConcurrencyLimiter} from the environment. Build it ONCE per facade. */
export function vendorConcurrencyLimiterFromEnv(
  get: (key: string) => string | undefined,
): VendorConcurrencyLimiter {
  return new VendorConcurrencyLimiter(vendorConcurrencyLimitsFromEnv(get))
}

/** A release that returns nothing to reclaim — the no-op for an uncapped vendor. */
const NOOP_RELEASE: PermitRelease = () => {}

/**
 * Holds one {@link Semaphore} per capped vendor. Build it ONCE per process (Node) / per
 * isolate (Worker) and share it across every `forScope` result so all inline calls to a
 * vendor contend for the same permits.
 */
export class VendorConcurrencyLimiter {
  private readonly semaphores = new Map<SubscriptionVendor, Semaphore>()

  constructor(limits: VendorConcurrencyLimits) {
    for (const [vendor, limit] of Object.entries(limits) as [SubscriptionVendor, number][]) {
      if (limit && limit > 0) this.semaphores.set(vendor, new Semaphore(limit))
    }
  }

  /** The configured cap for a vendor, or undefined when it is uncapped. */
  limitFor(vendor: SubscriptionVendor): number | undefined {
    return this.semaphores.has(vendor) ? this.semaphores.get(vendor)!.permits : undefined
  }

  /** No vendor is capped — the limiter is a pure pass-through. */
  get isEmpty(): boolean {
    return this.semaphores.size === 0
  }

  /**
   * Acquire a permit for `vendor`, resolving with its release; an uncapped vendor resolves with
   * a no-op release immediately. Pass `signal` so a queued acquire for a cancelled call bails.
   */
  acquire(vendor: SubscriptionVendor, signal?: AbortSignal): Promise<PermitRelease> {
    const sem = this.semaphores.get(vendor)
    return sem ? sem.acquire(signal) : Promise.resolve(NOOP_RELEASE)
  }

  /** Run `fn` under the vendor's permit, or immediately if the vendor is uncapped. */
  async run<T>(
    vendor: SubscriptionVendor,
    fn: () => PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const sem = this.semaphores.get(vendor)
    return sem ? sem.run(fn, signal) : fn()
  }
}

/**
 * A {@link ModelProvider} decorator that gates each resolved subscription-vendor model behind
 * the shared {@link VendorConcurrencyLimiter}. Mirrors {@link InstrumentedModelProvider}'s
 * shape (wrap the resolved model with an AI SDK middleware); apply it as the OUTERMOST wrap so
 * the queue wait is excluded from the instrumentation's generation timing. Both the buffered
 * (`wrapGenerate`) and streaming (`wrapStream`) paths are gated: a permit is held for the whole
 * generation, and for a stream it is held until the stream ends / errors / is cancelled — so a
 * streamed call counts against the cap exactly like a buffered one. A queued call whose request
 * is aborted releases its slot instead of head-of-line blocking behind it.
 */
export class LimitedModelProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly limiter: VendorConcurrencyLimiter,
  ) {}

  resolve(ref: ModelRef): LanguageModel {
    const model = this.inner.resolve(ref)
    const vendor = subscriptionVendorForRef(ref)
    // Only wrap when this ref actually targets a capped subscription vendor; a string ref
    // (unusual for inline) and any uncapped vendor pass straight through untouched.
    if (typeof model === 'string' || !vendor || this.limiter.limitFor(vendor) === undefined) {
      return model
    }
    return wrapLanguageModel({
      model: model as Parameters<typeof wrapLanguageModel>[0]['model'],
      middleware: this.middlewareFor(vendor),
    })
  }

  private middlewareFor(vendor: SubscriptionVendor): LanguageModelMiddleware {
    return {
      specificationVersion: 'v3',
      wrapGenerate: ({ doGenerate, params }) =>
        this.limiter.run(vendor, doGenerate, params.abortSignal),
      wrapStream: async ({ doStream, params }) => {
        // Hold the permit across the whole stream, not just the doStream() call: acquire before
        // starting and release when the stream terminates (drained / errored / cancelled).
        const release = await this.limiter.acquire(vendor, params.abortSignal)
        try {
          const result = await doStream()
          return { ...result, stream: releaseWhenDone(result.stream, release) }
        } catch (err) {
          release()
          throw err
        }
      },
    }
  }
}

/** Pipe `stream` through so `release` fires exactly once when it ends, errors, or is cancelled. */
function releaseWhenDone<T>(stream: ReadableStream<T>, release: PermitRelease): ReadableStream<T> {
  const reader = stream.getReader()
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          release()
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (err) {
        release()
        controller.error(err)
      }
    },
    cancel(reason) {
      release()
      return reader.cancel(reason)
    },
  })
}

/** Wrap `inner` with a per-vendor concurrency cap. A pass-through limiter returns `inner`. */
export function limitModelProvider(
  inner: ModelProvider,
  limiter: VendorConcurrencyLimiter,
): ModelProvider {
  return limiter.isEmpty ? inner : new LimitedModelProvider(inner, limiter)
}
