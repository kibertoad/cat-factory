import { createOtelLogExporter } from '@cat-factory/observability-otel'
import { type Logger, type OtelConfig, setLogSink } from '@cat-factory/server'

// Node's half of the runtime-symmetric OTLP LOG export: install the exporter as the logging
// adapter's second destination and flush it on an interval.
//
// The Worker's half (`infrastructure/observability/logExport.ts` there) installs the same
// fetch-based exporter but flushes at the end of every invocation instead, because a Worker's module
// state is per ISOLATE and an isolate is discarded without notice, so a timer would be a
// promise that runtime cannot keep. Node holds ONE process for the life of the deployment, so
// an interval loses nothing and batches far better than a per-request flush would.

export interface LogExportHandle {
  /**
   * Halt the interval, detach the sink, and deliver what is still buffered. Awaited on the
   * shutdown path AFTER the other stops, so the lines those emit are exported too: a
   * deployment's last words are usually the interesting ones.
   */
  stop: () => Promise<void>
}

/**
 * Start the OTLP log export. A NO-OP (a stop that resolves immediately) unless the base OTel
 * exporter is configured (endpoint present) AND `OTEL_LOGS=true`, so a deployment that has not
 * opted in pays nothing at all: no sink is installed, and the logging adapter's fan-out stays
 * a null check per line.
 *
 * Lines emitted BEFORE this runs (the `LOG_LEVEL` read, the process guards, config validation,
 * migrations) reach the local writer only: config has to be resolved before an endpoint is
 * known, and buffering against an endpoint that may never arrive would be a memory leak on
 * exactly the boots that fail. Documented in the package README rather than papered over.
 */
export function startOtelLogExport(
  otel: OtelConfig,
  log: Logger,
  /** Injectable fetch (tests); defaults to the global. Mirrors the Worker's own seam. */
  deps: { fetchImpl?: typeof fetch } = {},
): LogExportHandle {
  if (!otel.logs.enabled || !otel.endpoint) return { stop: async () => {} }

  const exporter = createOtelLogExporter({
    endpoint: otel.endpoint,
    headers: otel.headers,
    serviceName: otel.serviceName,
    maxBatchSize: otel.logs.maxBatchSize,
    // The exporter reports its OWN failures through this logger, and refuses to export what
    // it emits there (see `SELF_LOG_FIELD`): a collector outage must not become a batch of
    // lines about a collector outage.
    logger: log,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  })
  setLogSink(exporter)

  // `void` rather than awaiting: `flush` never rejects (the port requires it), and an interval
  // callback has nobody to hand a rejection to anyway.
  const timer = setInterval(() => void exporter.flush(), otel.logs.flushIntervalMs)
  // Node keeps the event loop alive for a pending timer; an observability flush must never be
  // the reason a process outlives its work.
  timer.unref?.()

  log.info('exporting logs to OTLP endpoint', {
    scope: 'otel-logs',
    flushIntervalMs: otel.logs.flushIntervalMs,
    maxBatchSize: otel.logs.maxBatchSize,
  })

  return {
    stop: async () => {
      clearInterval(timer)
      // Detach FIRST, so anything logged during the final flush cannot re-enter the buffer
      // being drained and keep the drain loop alive.
      setLogSink(null)
      await exporter.flush()
    },
  }
}
