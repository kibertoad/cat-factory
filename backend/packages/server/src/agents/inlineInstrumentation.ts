import type { WorkspaceBodiesGate } from '@cat-factory/agents'
import { createStoreAgentContextGate } from '@cat-factory/kernel'
import type {
  Clock,
  GroupCacheHandle,
  IdGenerator,
  LlmCallMetricRepository,
  LlmTraceSink,
  Logger,
  WorkspaceSettingsCacheValue,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { LlmObservabilityService, makeInlineCallRecorder } from '@cat-factory/orchestration'
import type { ScopedModelProviderOptions } from './modelProviderResolver.js'

/** The `instrument` slot of {@link ScopedModelProviderOptions}, once composed. */
export type InlineInstrumentation = NonNullable<ScopedModelProviderOptions['instrument']>

export interface InlineInstrumentationOptions {
  /**
   * The LLM-call telemetry store. Present ⇒ inline calls are PERSISTED (and, through the
   * service built here, fanned out to {@link traceSink}). Absent ⇒ the trace sink alone.
   */
  llmCallMetricRepository?: LlmCallMetricRepository
  /** The facade's composed external sink (Langfuse / OTel), when it wired one. */
  traceSink?: LlmTraceSink
  /** The deployment-wide `LLM_RECORD_PROMPTS` switch. */
  recordPrompts: boolean
  /**
   * The per-workspace `storeAgentContext` opt-out source. Threaded from the composition
   * root's repository set (not rebuilt from a `db` handle) so mothership mode's routed
   * repository is the one consulted.
   */
  workspaceSettingsRepository?: WorkspaceSettingsRepository
  /** The shared `AppCaches.workspaceSettings` slice, when the facade has one. */
  workspaceSettingsCache?: GroupCacheHandle<WorkspaceSettingsCacheValue>
  idGenerator: IdGenerator
  clock: Clock
  logger?: Logger
}

/**
 * Compose the inline-LLM instrumentation both facades hand to
 * `createScopedModelProviderResolver`, so the two exits of `InstrumentedModelProvider` can only
 * ever be wired as a matched pair.
 *
 * The provider takes EXACTLY ONE exit per call: the recorder's `LlmObservabilityService`
 * performs the trace-sink fan-out itself, so a recorded call must not ALSO be emitted to the
 * provider's own sink or every inline generation doubles on Langfuse/OTel. That makes "the sink
 * the provider holds must be the very instance the recorder's service was built with" a real
 * invariant — and one a hand-assembled facade block can silently violate, since handing over two
 * different sinks typechecks and merely splits the trace. Composing both here from ONE
 * {@link InlineInstrumentationOptions.traceSink} makes the mismatch unrepresentable, and keeps
 * the body gate's two halves (this provider's, and the identical one inside the service) built
 * from a single call to `createStoreAgentContextGate`.
 *
 * Returns `undefined` when neither exit can be built — the provider refuses a wrap that would
 * instrument nothing, so the caller must leave `instrument` unset rather than pass an empty one.
 */
export function createInlineInstrumentation(
  opts: InlineInstrumentationOptions,
): InlineInstrumentation | undefined {
  const {
    llmCallMetricRepository,
    traceSink,
    recordPrompts,
    workspaceSettingsRepository,
    workspaceSettingsCache,
    idGenerator,
    clock,
    logger,
  } = opts
  if (!llmCallMetricRepository && !traceSink) return undefined
  const recordCall = llmCallMetricRepository
    ? makeInlineCallRecorder(
        new LlmObservabilityService({
          llmCallMetricRepository,
          idGenerator,
          clock,
          recordPrompts,
          // The sink goes to THIS service, never to the provider beside the recorder.
          ...(traceSink ? { traceSink } : {}),
          ...(workspaceSettingsRepository ? { workspaceSettingsRepository } : {}),
          ...(workspaceSettingsCache ? { workspaceSettingsCache } : {}),
          ...(logger ? { logger } : {}),
        }),
      )
    : undefined
  const workspaceBodiesEnabled: WorkspaceBodiesGate = createStoreAgentContextGate({
    ...(workspaceSettingsRepository ? { repository: workspaceSettingsRepository } : {}),
    ...(workspaceSettingsCache ? { cache: workspaceSettingsCache } : {}),
  })
  return {
    ...(recordCall ? { recordCall } : {}),
    // The sink exit remains for the calls the recorder structurally cannot take — an inline
    // call tagged with no workspace has no row to be filed under.
    ...(traceSink ? { traceSink } : {}),
    recordPrompts,
    workspaceBodiesEnabled,
  }
}
