import { type OtelLogExporter, createOtelLogExporter } from '@cat-factory/observability-otel'
import { type Logger, type OtelConfig, logger, setLogSink } from '@cat-factory/server'

// The Worker's half of the runtime-symmetric OTLP LOG export. Same fetch-based exporter as
// Node's (`runtimes/node/src/logExport.ts`); the difference is entirely in WHEN it is drained,
// and it is the same difference the operational-metrics flush next door already documents.
//
// Node holds one process, so it flushes on a timer. A Worker's module state is per ISOLATE and
// an isolate is discarded whenever the runtime decides, so a buffered line has no later tick
// guaranteed to reach it: every entry point installs the sink for its isolate and flushes what
// that isolate accumulated as a `waitUntil` after the response. Lines therefore leave in
// per-invocation batches, which is also why the exporter POSTs the batch it is given rather
// than holding one open across calls.
//
// Cost, stated rather than assumed: one extra OTLP POST per invocation that logged anything,
// which (the request-logging middleware emits a line per request) is essentially every
// invocation. That is the price of a Worker having no background time of its own, and it is
// paid only by a deployment that opted in (`OTEL_LOGS` on top of a configured exporter).

/**
 * This ISOLATE's exporter. Module state so a second invocation on the same isolate reuses the
 * buffer the first one installed rather than orphaning it: an exporter replaced mid-life would
 * take whatever it still held with it.
 */
let installed: OtelLogExporter | null = null
/** The endpoint {@link installed} was built for, so a config change rebuilds it. */
let installedFor: string | null = null

/**
 * Install the OTLP log sink for this isolate, returning the exporter (or `null` when the
 * deployment has not opted in, in which case no sink is installed and the logging adapter's
 * fan-out stays a null check per line).
 *
 * Idempotent and cheap: every entry point calls it, because a `scheduled` or `queue`
 * invocation can be the FIRST to run in a fresh isolate, exactly like the `LOG_LEVEL` read it
 * sits beside.
 */
export function installOtelLogSink(
  otel: OtelConfig,
  deps: { logger?: Logger; fetchImpl?: typeof fetch } = {},
): OtelLogExporter | null {
  if (!otel.logs.enabled || !otel.endpoint) return null
  if (installed && installedFor === otel.endpoint) return installed
  installed = createOtelLogExporter({
    endpoint: otel.endpoint,
    headers: otel.headers,
    serviceName: otel.serviceName,
    maxBatchSize: otel.logs.maxBatchSize,
    logger: deps.logger ?? logger,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  })
  installedFor = otel.endpoint
  setLogSink(installed)
  return installed
}

/**
 * Flush whatever THIS isolate has buffered, returning the in-flight promise for the caller to
 * `ctx.waitUntil`, or `null` when nothing is installed (nothing to schedule).
 *
 * Best-effort, like every other export path here: the returned promise always resolves, so
 * `waitUntil` never sees a rejection.
 */
export function flushOtelLogsForIsolate(otel: OtelConfig): Promise<void> | null {
  const exporter = installOtelLogSink(otel)
  return exporter ? exporter.flush() : null
}
