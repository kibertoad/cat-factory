import { createLangfuseSink } from '@cat-factory/observability-langfuse'
import { createOtelSink } from '@cat-factory/observability-otel'
import { type LlmTraceSink, composeTraceSinks } from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { logger } from '@cat-factory/server'
import { type AppConfig, type LangfuseConfig, type OtelConfig } from './config'

// ---------------------------------------------------------------------------
// External LLM-TRACE DESTINATIONS for the Worker facade — one cohesive concern lifted out
// of `container.ts` (which is at its size ratchet), following the same convention as
// `container-assembly.ts` / `container-registries.ts` / `github-deps.ts`.
//
// Both sinks are fetch-based so they run unchanged on workerd; both are opt-in, so a
// deployment that configures neither leaves the slot empty.
// ---------------------------------------------------------------------------

/**
 * The opt-in Langfuse trace sink. Built only when `LANGFUSE_ENABLED=true` and both keys are
 * set. A fetch-based sink, so it runs unchanged on the Worker runtime.
 */
export function buildLangfuseSink(langfuse: LangfuseConfig): LlmTraceSink | undefined {
  if (!langfuse.enabled || !langfuse.publicKey || !langfuse.secretKey) return undefined
  return createLangfuseSink({
    publicKey: langfuse.publicKey,
    secretKey: langfuse.secretKey,
    baseUrl: langfuse.baseUrl,
    logger,
  })
}

/**
 * The opt-in OpenTelemetry OTLP exporter. Built only when `OTEL_ENABLED=true` and an
 * endpoint is set. The Worker uses the FETCH-based exporter (`createOtelSink`) so it runs
 * on workerd; the Node facade uses the official-SDK exporter instead (both conformant).
 */
export function buildOtelSink(otel: OtelConfig): LlmTraceSink | undefined {
  if (!otel.enabled || !otel.endpoint) return undefined
  return createOtelSink({
    endpoint: otel.endpoint,
    headers: otel.headers,
    serviceName: otel.serviceName,
    logger,
  })
}

// Memoised per config so every wiring site (the core sink slot, the container executor, the
// repo bootstrapper's trajectory drain) shares ONE instance, as the Node sibling does, where
// the OTel SDK sink owns batch processors an extra instance would strand. Both sinks are
// fetch-based here today, which makes the duplicate cheap rather than harmless: a sink that
// later buffers would leave the bootstrapper's spans in an instance nobody flushes.
const traceSinkCache = new WeakMap<AppConfig, CoreDependencies['llmTraceSink']>()

/**
 * Compose every enabled external trace destination into the single sink slot: none ⇒
 * undefined, one ⇒ that sink, both ⇒ a fan-out. The observability service then fans every
 * recorded LLM call (+ tool spans) out to whichever are wired. Memoised per config, so all
 * wiring sites share one instance.
 */
export function buildTraceSink(config: AppConfig): CoreDependencies['llmTraceSink'] {
  if (traceSinkCache.has(config)) return traceSinkCache.get(config)
  const sink = composeTraceSinks([buildLangfuseSink(config.langfuse), buildOtelSink(config.otel)])
  traceSinkCache.set(config, sink)
  return sink
}

export function selectTraceSink(config: AppConfig): Partial<CoreDependencies> {
  const sink = buildTraceSink(config)
  return sink ? { llmTraceSink: sink } : {}
}
