// The Worker's INLINE model-provider resolution: the memoised `ModelProviderResolver` every
// inline consumer shares (agent executor, requirements reviewer, doc planner, fragment
// selector, the sandbox) plus the per-step workspace-default resolver they all consult.
//
// Split out of `container.ts` along the same seam the Node facade already draws with
// `container-model-deps.ts`: model resolution is what everything else in the composition root
// is *given*, not part of assembling it, and keeping it here is what lets the executor wiring
// (`container-executor-deps.ts`) import it without either module reaching back into the root.

import {
  type ModelFlavor,
  type ModelProviderResolver,
  composeTraceSinks,
} from '@cat-factory/kernel'
import { vendorConcurrencyLimiterFromEnv } from '@cat-factory/agents'
import { cloudflareBindingRegistry } from '@cat-factory/provider-cloudflare'
import { buildLangfuseSink, buildOtelSink } from './container-trace-sinks.js'
import {
  resolvePresetModelForKind,
  resolvePresetProviderPreference,
} from '@cat-factory/orchestration'
import {
  logger,
  createInlineInstrumentation,
  createScopedModelProviderResolver,
  wrapResolverWithTelemetry,
} from '@cat-factory/server'
import { loadLangfuseConfig } from './config/langfuse'
import { loadObservabilityConfig } from './config/observability'
import { loadOtelConfig } from './config/otel'
import type { Env } from './env'
import { requireTelemetryDb } from './env'
import { baseUrlFor } from './ai/providerEndpoints'
import { resolveExtraRegistries } from './ai/registries'
import { D1LlmCallMetricRepository } from './repositories/D1LlmCallMetricRepository'
import { D1WorkspaceSettingsRepository } from './repositories/D1WorkspaceSettingsRepository'
import { D1ModelPresetRepository } from './repositories/D1ModelPresetRepository'
import { buildApiKeyService, buildLocalModelEndpointService } from './wireCredentialServices'
import { CryptoIdGenerator, SystemClock } from './runtime'
import type { D1Database } from '@cloudflare/workers-types'

/**
 * The Worker's {@link ModelProvider}: the base registry plus any extra provider
 * registries an installation registered (see ./ai/registries). Used everywhere a
 * model provider is needed so every path — agent executor, requirements reviewer,
 * doc planner, fragment selector — sees the same provider set. When Langfuse is
 * configured the provider is wrapped so those INLINE (non-proxied) calls surface on
 * the same trace sink the LLM proxy fans container calls out to.
 */
// Memoised per `(Env, db)`: every inline consumer (agent executor, requirements
// reviewer, doc planner, fragment selector) shares ONE resolver — and so ONE Langfuse
// sink — for a container build. The resolver builds a per-scope provider from the
// DB-backed API-key pool plus the opt-in Cloudflare binding + Bedrock registries.
const modelResolverCache = new WeakMap<Env, ModelProviderResolver>()

export function buildModelProviderResolver(env: Env, db: D1Database): ModelProviderResolver {
  const cached = modelResolverCache.get(env)
  if (cached) return cached
  // Opt-in provider registries that need no per-scope DB key: the Cloudflare Workers
  // AI binding (when bound) and any extra registries (e.g. Bedrock). NOT assumed —
  // `workers-ai` resolves only when the `AI` binding is present.
  const extraRegistries = [
    ...(env.AI ? [cloudflareBindingRegistry({ binding: env.AI })] : []),
    ...resolveExtraRegistries(env),
  ]
  // Instrument inline (non-proxied) calls with the SAME composed trace sink the proxied
  // path uses — Langfuse and/or the OTLP exporter, whichever are enabled.
  const traceSink = composeTraceSinks([
    buildLangfuseSink(loadLangfuseConfig(env)),
    buildOtelSink(loadOtelConfig(env)),
  ])
  // Persist inline calls to the SAME `llm_call_metrics` store the proxy writes for Pi and
  // the executor writes for a subscription harness, so an inline agent kind (`doc-researcher`,
  // the judges, consensus, the requirements writer) is visible to `ObservabilityPanel`, the
  // per-step rollups and `/api/v1/debug/*` rather than only to an external trace backend.
  // Composed through the shared factory so the recorder's service and the provider's fallback
  // sink cannot be handed two DIFFERENT instances — the service owns the fan-out for a call it
  // records, so a mismatch would split the trace (and wiring both to the provider would double
  // every inline generation on Langfuse/OTel). No cache handle is passed because
  // `workspaceSettings` is a pass-through in the isolate-safe profile.
  const instrument = createInlineInstrumentation({
    llmCallMetricRepository: new D1LlmCallMetricRepository({ db: requireTelemetryDb(env) }),
    ...(traceSink ? { traceSink } : {}),
    recordPrompts: loadObservabilityConfig(env).recordPrompts,
    workspaceSettingsRepository: new D1WorkspaceSettingsRepository({ db }),
    idGenerator: new CryptoIdGenerator(),
    clock: new SystemClock(),
    logger,
  })
  const localModelEndpoints = buildLocalModelEndpointService(env, db, { now: () => Date.now() })
  const scoped = createScopedModelProviderResolver({
    apiKeys: buildApiKeyService(env, db, { now: () => Date.now() }),
    baseUrlFor: (provider) => baseUrlFor(provider, env) ?? undefined,
    extraRegistries,
    // The service itself, so the endpoint read and the transport carrying the deployment's
    // loopback/LAN policy (re-validated on every redirect hop, SEC-2/SEC-3) cannot come from
    // two different places.
    localRunners: localModelEndpoints,
  })
  // Observe inline calls, then cap concurrency, through the ONE composer that owns their order
  // (instrumentation inside, limiter outermost). The Worker has no facade wrap that substitutes a
  // resolved model today, so it could not hit the local-mode blind spot this order exists for —
  // but going through the shared composer is what keeps that true for a Worker-side wrap added
  // later, and it keeps the two facades textually symmetric. The limiter bounds concurrency within
  // one isolate only (no cross-isolate/global limiting — see
  // backend/docs/concurrency-and-redis.md), and since the Worker's inline path degrades
  // subscription refs before resolve, it is a wired pass-through here in practice.
  const resolver = wrapResolverWithTelemetry(scoped, {
    ...(instrument ? { instrument } : {}),
    limiter: vendorConcurrencyLimiterFromEnv(
      (key) => (env as unknown as Record<string, string | undefined>)[key],
    ),
  })
  modelResolverCache.set(env, resolver)
  return resolver
}

/**
 * The resolver every executor consults for a step's default model (block-pinned >
 * the task's selected/default model preset > env routing). Backed by the D1
 * model-preset repo; shared by the inline LLM executor and the container executor so
 * both honour the workspace presets identically. The built-in default preset points
 * every agent kind at Kimi K2.7, so an unpinned step resolves to it even before the
 * preset library is materialised.
 */
export function buildResolveWorkspaceModelDefault(
  db: D1Database,
): (workspaceId: string, agentKind: string, modelPresetId?: string) => Promise<string | undefined> {
  const repo = new D1ModelPresetRepository({ db })
  return (workspaceId, agentKind, modelPresetId) =>
    resolvePresetModelForKind(repo, workspaceId, agentKind, modelPresetId)
}

/**
 * The route ORDER a preset states, read from the same D1 preset repo as the model id above. Its
 * sibling: the model a step runs and the order that model's routes are tried in come from one row,
 * so a preset cannot pick a model on one surface and an order on another.
 */
export function buildResolvePresetProviderPreference(
  db: D1Database,
): (workspaceId: string, modelPresetId?: string) => Promise<readonly ModelFlavor[] | undefined> {
  const repo = new D1ModelPresetRepository({ db })
  return (workspaceId, modelPresetId) =>
    resolvePresetProviderPreference(repo, workspaceId, modelPresetId)
}
