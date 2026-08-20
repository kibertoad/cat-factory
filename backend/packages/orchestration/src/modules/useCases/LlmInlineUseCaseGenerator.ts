import { generateText } from 'ai'
import type { UseCaseFinishReason } from '@cat-factory/contracts'
import type {
  InlineUseCaseGeneration,
  InlineUseCaseGenerationRequest,
  InlineUseCaseGenerator,
  InlineUseCaseModelAvailability,
  InlineUseCaseModelOption,
  Logger,
  ModelFlavor,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
} from '@cat-factory/kernel'
import {
  describeError,
  getErrorMessage,
  resolveScopedModelProvider,
  UnavailableError,
} from '@cat-factory/kernel'
import { catFactoryObservability } from '@cat-factory/agents'

// ---------------------------------------------------------------------------
// The default {@link InlineUseCaseGenerator}: the inline LLM call behind an invocation of a
// registered use case.
//
// Structurally the `BugHuntAssessorService` twin, and for the same reason: an un-run-scoped inline
// call built from the model dependencies every facade already wires, so the feature needs no
// per-facade wiring of its own and the conformance harness swaps in a deterministic fake through
// the `InlineUseCaseGenerator` seam.
//
// Two things differ from every other inline caller, and both follow from the use case being a
// DECLARED narrowing rather than an engine step:
//
//  - There is no block, no task and no preset consult. A use case names its own models, so nothing
//    a workspace pinned elsewhere may reach in and change which model runs; the workspace's per-kind
//    preset default would be exactly such a substitution.
//  - A subscription-harness ref is REFUSED rather than degraded. Every other inline site degrades
//    one to the routing default (`inlineModelRef`), which is right where the model is an
//    implementation detail of a step. Here the model IS the request.
// ---------------------------------------------------------------------------

/** What the generator needs to resolve its models and reach the provider. */
export interface LlmInlineUseCaseGeneratorDeps {
  /** Resolve a ModelProvider for a workspace's credential scope (preferred). */
  modelProviderResolver?: ModelProviderResolver
  /** Static provider (e.g. a fake in tests) used when no resolver is set. */
  modelProvider?: ModelProvider
  /** Resolve a model catalog id to a ref, under the deployment's route order. */
  resolveBlockModel?: (
    modelId: string | undefined,
    providerPreference?: readonly ModelFlavor[],
  ) => ModelRef | undefined
  /** Keep an ambient-eligible harness ref inline (local mode) instead of refusing it. */
  runsInline?: (ref: ModelRef) => boolean
  /** Facade logger; a failed generation with no trace is an unowned bug. */
  logger?: Logger
}

/**
 * The AI SDK's finish reasons, mapped to the bounded wire class.
 *
 * `tool-calls` cannot occur (no tools are passed) and the SDK's `unknown`/`error` both mean the
 * provider said nothing usable about why it stopped, so they land on `other` rather than on a
 * fabricated `stop`. Reporting `stop` for an unknown finish would tell a caller the text is
 * complete when nothing said so.
 */
function mapFinishReason(reason: unknown): UseCaseFinishReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'content-filter':
      return 'content-filter'
    default:
      return 'other'
  }
}

/** Read the SDK's usage across its flat (v2) and nested (v3) shapes. */
function readUsage(usage: unknown): {
  inputTokens: number
  outputTokens: number
  totalTokens: number
} {
  const u = (usage ?? {}) as Record<string, unknown>
  const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
  const input =
    u.inputTokens && typeof u.inputTokens === 'object'
      ? num((u.inputTokens as { total?: number }).total)
      : num(u.inputTokens ?? u.promptTokens)
  const output =
    u.outputTokens && typeof u.outputTokens === 'object'
      ? num((u.outputTokens as { total?: number }).total)
      : num(u.outputTokens ?? u.completionTokens)
  const total = typeof u.totalTokens === 'number' ? u.totalTokens : input + output
  return { inputTokens: input, outputTokens: output, totalTokens: total }
}

export class LlmInlineUseCaseGenerator implements InlineUseCaseGenerator {
  constructor(private readonly deps: LlmInlineUseCaseGeneratorDeps) {}

  /** Whether a generation can run at all (some provider is wired). */
  get enabled(): boolean {
    return !!this.deps.modelProviderResolver || !!this.deps.modelProvider
  }

  async availability(
    workspaceId: string,
    option: InlineUseCaseModelOption,
  ): Promise<InlineUseCaseModelAvailability> {
    const ref = this.refFor(option)
    if (!ref) return { available: false, reason: 'provider_unavailable' }
    if (ref.harness && ref.harness !== 'pi' && !this.deps.runsInline?.(ref)) {
      // A subscription harness runs inside a per-run container against a pooled OAuth token. A use
      // case has no container and no run, so this is a permanent property of the pairing rather
      // than a missing credential, and it is reported as its own cause.
      return { available: false, reason: 'container_only' }
    }
    const provider = await resolveScopedModelProvider({ workspaceId }, this.deps)
    if (!provider) return { available: false, reason: 'provider_unavailable' }
    try {
      provider.resolve(ref)
    } catch (error) {
      // `resolve` throws for a provider id with no registered resolver, which on this platform means
      // the deployment configured no credentials for it. Logged rather than swallowed: an operator
      // reading "unavailable" on a model they believe they configured needs the resolver's own
      // message, which names what IS registered.
      this.deps.logger?.debug('A use-case model did not resolve', {
        workspaceId,
        model: option.id,
        ...describeError(error),
      })
      return { available: false, reason: 'provider_unavailable' }
    }
    return { available: true, ref }
  }

  async generate(request: InlineUseCaseGenerationRequest): Promise<InlineUseCaseGeneration> {
    const availability = await this.availability(request.workspaceId, request.option)
    if (!availability.available) {
      throw new UnavailableError(
        `The model '${request.option.label}' cannot be served by this deployment`,
        'use_case_model_unavailable',
        { model: request.option.id, cause: availability.reason },
      )
    }
    const provider = await resolveScopedModelProvider(
      { workspaceId: request.workspaceId },
      this.deps,
    )
    if (!provider) {
      throw new UnavailableError(
        'No model provider is configured, so use cases cannot be invoked',
        'use_case_models_unconfigured',
      )
    }
    try {
      const result = await generateText({
        model: provider.resolve(availability.ref),
        system: request.system,
        prompt: request.prompt,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        // The call is tagged with the use case as its agent kind, so its tokens land in the same
        // rollups every other inline call does and an operator can see what an editor is spending
        // per use case rather than as one undifferentiated "inline" bucket.
        providerOptions: catFactoryObservability({
          agentKind: request.useCaseId,
          workspaceId: request.workspaceId,
        }),
      })
      return {
        text: result.text,
        finishReason: mapFinishReason(result.finishReason),
        usage: readUsage(result.usage),
        ref: availability.ref,
      }
    } catch (error) {
      const message = `The use-case model '${request.option.label}' failed: ${getErrorMessage(error)}`
      this.deps.logger?.warn(message, {
        workspaceId: request.workspaceId,
        useCaseId: request.useCaseId,
        model: request.option.id,
      })
      throw new UnavailableError(message, 'use_case_generation_failed', {
        model: request.option.id,
      })
    }
  }

  /** The ref one declared option resolves to, or undefined when this deployment cannot serve it. */
  private refFor(option: InlineUseCaseModelOption): ModelRef | undefined {
    if (option.source.kind === 'provider') return option.source.ref
    // A catalog id resolves under the DEPLOYMENT's default route order rather than a preset's: a
    // use case is workspace-agnostic by construction (nothing about it is stored per workspace), so
    // there is no preset in force to read an order off.
    return this.deps.resolveBlockModel?.(option.source.modelId)
  }
}
