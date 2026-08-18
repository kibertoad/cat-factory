import type { Logger } from '@cat-factory/kernel'
import { OtelTraceSink } from '@cat-factory/observability-otel'

// The opt-in Langfuse trace sink, which is now the OTLP exporter pointed at Langfuse.
//
// It used to be its own fetch client speaking Langfuse's ingestion API
// (`POST /api/public/ingestion`, batched `trace-create` / `generation-create` / `span-create`
// events). That API is deprecated and sunsets on Langfuse Cloud on 2026-11-16, and the three event
// types this sent are already unsupported on the v4 data model: "Trace, span, and generation events
// via the legacy batch ingestion API are not supported on the v4 data model". The supported path is
// OTLP, which this repo already speaks: `@cat-factory/observability-otel` hand-writes an OTLP/HTTP
// JSON exporter for exactly the same three shapes, so the migration retargets an encoder rather
// than writing one, and Langfuse becomes a DESTINATION instead of a second recording path.
//
// What differs from a plain collector, and it is only these three things:
//   - the endpoint is `{base}/api/public/otel`, so the exporter's own `/v1/traces` append lands on
//     Langfuse's documented signal path;
//   - auth is HTTP Basic over `publicKey:secretKey`, the same credential pair as before;
//   - `x-langfuse-ingestion-version: 4` is required for real-time ingestion on v4. Without it the
//     data still arrives, up to ten minutes late, which is the kind of delay that reads as data
//     loss to whoever is watching a run.
//
// METRICS ARE OFF because Langfuse implements the traces signal only. Posting `/v1/metrics` there
// would 404 once per generation, a per-call failure that says nothing about the deployment.
//
// The contract the two sinks share is unchanged and is documented on the exporter: observability
// must never break the product, so every method swallows its own errors (logging at most a
// warning), each POST is timeout-bounded, and a dropped batch is the worst case. No `langfuse` SDK
// and no `@opentelemetry/*`: both depend on Node-only APIs that are unavailable on workerd, which
// is why the fetch-based exporter exists at all.
//
// Read 2026-08-18: https://langfuse.com/docs/api, https://langfuse.com/docs/compatibility,
// https://langfuse.com/integrations/native/opentelemetry

/** Langfuse Cloud EU. The US, Japan and HIPAA clouds are the same shape on their own hosts. */
const DEFAULT_BASE_URL = 'https://cloud.langfuse.com'

/** Langfuse's OTLP path, onto which the exporter appends the `/v1/traces` signal segment. */
const OTEL_PATH = '/api/public/otel'

export interface LangfuseSinkConfig {
  /** Langfuse public key (`pk-lf-…`). */
  publicKey: string
  /** Langfuse secret key (`sk-lf-…`). */
  secretKey: string
  /** Host of the Langfuse instance. Default: Langfuse Cloud (`https://cloud.langfuse.com`). */
  baseUrl?: string
  /** OTLP resource `service.name`, as it appears on the exported spans. */
  serviceName?: string
  /** Optional logger for swallowed errors. */
  logger?: Logger
  /** Injectable fetch (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

function basicAuth(publicKey: string, secretKey: string): string {
  return `Basic ${btoa(`${publicKey}:${secretKey}`)}`
}

/**
 * The OTLP exporter, configured for a Langfuse project.
 *
 * A subclass rather than a factory returning the base type, because a facade composing several
 * sinks has to be able to say WHICH destination it wired: `CompositeTraceSink` holds a list, and
 * two members of the same class are indistinguishable to the wiring assertions that keep the
 * facades symmetric.
 */
export class LangfuseTraceSink extends OtelTraceSink {
  constructor(config: LangfuseSinkConfig) {
    const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    super({
      endpoint: `${base}${OTEL_PATH}`,
      exportMetrics: false,
      headers: {
        authorization: basicAuth(config.publicKey, config.secretKey),
        'x-langfuse-ingestion-version': '4',
      },
      ...(config.serviceName ? { serviceName: config.serviceName } : {}),
      ...(config.logger ? { logger: config.logger } : {}),
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    })
  }
}

/** Build a {@link LangfuseTraceSink}. Returns the opt-in sink wired into a facade. */
export function createLangfuseSink(config: LangfuseSinkConfig): LangfuseTraceSink {
  return new LangfuseTraceSink(config)
}
