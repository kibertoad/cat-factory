import { flushOperationalMetrics } from '@cat-factory/orchestration'
import { createPlatformMetricsOtelExporter } from '@cat-factory/observability-otel'
import { type Logger, type OtelConfig, logger, operationalMetrics } from '@cat-factory/server'

// The Worker's flush of the operational-metrics collector, and the one place this facade
// deliberately differs from Node in TIMING rather than in behaviour.
//
// Node holds ONE collector for the life of the process, so its platform-metrics sweep drains
// it on an interval and nothing is lost in between. A Worker's module state is per ISOLATE,
// and an isolate is discarded whenever the runtime decides — so a counter incremented while
// serving a request is gone long before the next cron tick, which runs in a DIFFERENT isolate
// that saw none of it. Draining only on cron here would report the cron's own handful of
// events and silently zero everything the request and queue paths did, which is precisely the
// "an absent number reads as a zero" failure this initiative exists to remove.
//
// So every entry point flushes what its own isolate accumulated, as a `waitUntil` after the
// response. That is only correct because the counters export as DELTAS: N isolates each
// reporting their own slice sum correctly in the backend, where N isolates each reporting a
// cumulative total would not. The CRON path flushes through `SweepTick.settled()` rather than
// immediately — its passes run on `waitUntil` and record after the handler returns, so a flush
// that did not wait for them drained an empty collector and orphaned their counters in an
// isolate no later tick was guaranteed to reach.
//
// Cost, stated plainly rather than optimistically: this is one extra OTLP POST per invocation
// that recorded ANYTHING, and since `cache.hit`/`cache.miss` fire on every app-cache read, that
// is in practice most requests — not the rare invocation the "only when there is something to
// say" guard might suggest. It is accepted rather than coalesced: the alternatives (a sample
// threshold, a time window) buy request volume by dropping whatever an evicted isolate still
// held, and under-reporting is the exact failure this initiative exists to remove. It costs
// nothing unless a deployment opted into platform metrics (`OTEL_PLATFORM_METRICS` on top of a
// configured exporter — off by default), and an invocation that recorded nothing still sends
// nothing, so an idle isolate and the unconfigured default both stay free.
//
// Not covered, and stated rather than papered over: Cloudflare Queues expose no backlog depth
// to the Worker consuming them, so this facade emits NO `queue.depth` gauge where Node emits
// one per pg-boss queue. An absent series says "nobody could look"; a zero would say "the
// queue is empty", and for a wedged queue those are opposite claims.

/**
 * Flush this isolate's accumulated operational counters, returning the in-flight promise for
 * the caller to `ctx.waitUntil`. Returns `null` (nothing to schedule) when the deployment has
 * not opted into platform metrics — the collector then simply keeps accumulating into an
 * isolate that will be discarded, which costs a Map and nothing else.
 *
 * Self-logging and best-effort: the returned promise always resolves, so `waitUntil` never
 * sees a rejection.
 */
export function flushOperationalMetricsForIsolate(
  otel: OtelConfig,
  now: number,
  deps: { logger?: Logger; fetchImpl?: typeof fetch } = {},
): Promise<void> | null {
  if (!otel.platformMetrics.enabled || !otel.endpoint) return null
  const log = deps.logger ?? logger
  const exporter = createPlatformMetricsOtelExporter({
    endpoint: otel.endpoint,
    headers: otel.headers,
    serviceName: otel.serviceName,
    logger: log,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  })
  return flushOperationalMetrics({
    collector: operationalMetrics,
    sink: exporter,
    now,
    logger: log,
  }).then(() => {})
}
