import type {
  Logger,
  OperationalCounterSample,
  OperationalGaugeSample,
  OperationalMetricsCollector,
} from '@cat-factory/kernel'

// The flush half of the operational-metrics seam (kernel `ports/operational-metrics.ts`).
// Services and sweepers COUNT events into an in-memory collector; this drains it and hands
// the deltas — plus any point-in-time gauges the runtime can probe — to the metrics sink.
//
// WHO calls this, and how often, is a genuine runtime differentiator rather than a parity
// gap, and it is the reason the counters are exported as DELTAS:
//   - Node/local hold ONE collector for the life of the process, so the platform-metrics
//     sweep drains it on its own interval and nothing is lost between flushes.
//   - The Worker holds one collector PER ISOLATE, and an isolate is discarded whenever the
//     runtime feels like it — anything unflushed when that happens is simply gone. So the
//     Worker flushes at the end of every invocation that recorded something. Two isolates
//     each reporting their own delta sum correctly in the backend; two isolates each
//     reporting a cumulative total would not.
//
// Best-effort throughout: this is observability, so a failed flush degrades telemetry
// completeness and must never propagate into the caller (the request, the cron, the sweep).

/** Where a flush pushes its operational samples (the OTLP platform-metrics exporter). */
export interface OperationalMetricsSink {
  exportOperational(
    counters: OperationalCounterSample[],
    gauges: OperationalGaugeSample[],
    at: number,
  ): Promise<void>
}

export interface OperationalMetricsFlushDeps {
  /** The process/isolate-local accumulator to drain. */
  collector: OperationalMetricsCollector
  sink: OperationalMetricsSink
  /**
   * Read the point-in-time gauges this runtime can answer (queue depth). OMITTED where the
   * runtime genuinely cannot read them — Cloudflare Queues expose no backlog to the Worker
   * that consumes them — in which case nothing is emitted for those series. That is
   * deliberate: an absent data point says "nobody could look", where a zero would say "the
   * queue is empty", and those are opposite facts about a wedged queue.
   */
  probeGauges?: () => Promise<OperationalGaugeSample[]>
  /** The flush clock (injected, so this module reads no wall clock of its own). */
  now: number
  logger?: Logger
}

/**
 * Drain the collector, probe the gauges, and export both. Returns the number of samples sent
 * (0 when there was nothing to say, in which case no request is made at all).
 *
 * A gauge probe that THROWS costs only its gauges: the drained counters are already out of
 * the collector by then, and dropping them because an unrelated `COUNT(*)` failed would lose
 * events nothing can recover. A failing SINK loses the whole flush — that is the accepted
 * cost of an in-memory accumulator, and it is why the drop is logged rather than swallowed.
 */
export async function flushOperationalMetrics(deps: OperationalMetricsFlushDeps): Promise<number> {
  const counters = deps.collector.drain()
  let gauges: OperationalGaugeSample[] = []
  if (deps.probeGauges) {
    try {
      gauges = await deps.probeGauges()
    } catch (err) {
      deps.logger?.warn('operational-metrics: gauge probe failed; exporting counters only', {
        scope: 'operational-metrics',
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (counters.length === 0 && gauges.length === 0) return 0
  try {
    await deps.sink.exportOperational(counters, gauges, deps.now)
  } catch (err) {
    deps.logger?.warn('operational-metrics: export failed; the drained deltas are lost', {
      scope: 'operational-metrics',
      counters: counters.length,
      gauges: gauges.length,
      err: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
  return counters.length + gauges.length
}
