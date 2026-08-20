import { generateText } from 'ai'
import type {
  InlineUseCaseGeneration,
  InlineUseCaseGenerationRequest,
  InlineUseCaseGenerator,
  InlineUseCaseModelAvailability,
  InlineUseCaseModelOption,
  InlineUseCaseScope,
  InlineUseCaseSession,
  Logger,
  ModelFlavor,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
  ModelScope,
} from '@cat-factory/kernel'
import {
  describeError,
  getErrorMessage,
  resolveScopedModelProvider,
  runsOnSubscriptionHarness,
  UnavailableError,
} from '@cat-factory/kernel'
import { catFactoryObservability } from '@cat-factory/agents'
import type { UseCaseFinishReason } from '@cat-factory/contracts'
import { readUseCaseUsage } from './useCaseUsage.js'

// ---------------------------------------------------------------------------
// The default {@link InlineUseCaseGenerator}: the inline LLM call behind an invocation of a
// registered use case.
//
// Structurally the `BugHuntAssessorService` twin, and for the same reason: an un-run-scoped inline
// call built from the model dependencies every facade already wires, so the feature needs no
// per-facade wiring of its own and the conformance harness swaps in a deterministic fake through
// the `InlineUseCaseGenerator` seam.
//
// Three things differ from every other inline caller. Two follow from the use case being a DECLARED
// narrowing rather than an engine step:
//
//  - There is no block, no task and no preset consult. A use case names its own models, so nothing
//    a workspace pinned elsewhere may reach in and change which model runs; the workspace's per-kind
//    preset default would be exactly such a substitution.
//  - A subscription-harness ref is REFUSED rather than degraded. Every other inline site degrades
//    one to the routing default (`inlineModelRef`), which is right where the model is an
//    implementation detail of a step. Here the model IS the request.
//
// The third follows from the surface being SYNCHRONOUS: the call is bounded by a deadline and one
// retry. Every other long-running model path in this repo is a dispatched job with a poll and a
// watchdog; this one is a request the caller is holding open, so an unbounded vendor stall would be
// paid for by whoever asked.
// ---------------------------------------------------------------------------

/**
 * How long one invocation may wait on the vendor, by default.
 *
 * Generous, because the ceiling on `maxOutputTokens` is 32,000 and a long scene legitimately takes
 * minutes, but FINITE: the alternative is a request held open for as long as the transport allows,
 * on a surface whose whole shape is "ask and be answered". A deployment narrows it per facade.
 */
export const DEFAULT_USE_CASE_TIMEOUT_MS = 120_000

/**
 * Retries the AI SDK may make inside one invocation.
 *
 * ONE, against the SDK's default of two: a transient 429 or 502 is worth a second attempt, and the
 * third would be spent inside a deadline the caller is already waiting out. The deadline covers all
 * attempts together (one signal, one absolute expiry), so retrying cannot extend it.
 */
const USE_CASE_MAX_RETRIES = 1

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
  /** The per-invocation deadline; absent ⇒ {@link DEFAULT_USE_CASE_TIMEOUT_MS}. */
  timeoutMs?: number
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

/**
 * The credential scope, as the model-provider resolver takes it.
 *
 * An absent account or user is OMITTED rather than passed as null, because the two are different
 * instructions to the pool: omitted means "resolve the workspace's owning account yourself", while
 * an explicit null means "this pool has no account tier". Passing null for an unknown account would
 * silently drop every account-scoped key.
 */
function modelScopeFor(scope: InlineUseCaseScope): ModelScope {
  return {
    workspaceId: scope.workspaceId,
    ...(scope.accountId ? { accountId: scope.accountId } : {}),
    ...(scope.userId ? { userId: scope.userId } : {}),
  }
}

/**
 * One request's generator: the credential pool, resolved once, plus the two answers that read it.
 *
 * Everything expensive happened in {@link LlmInlineUseCaseGenerator.forScope}, which is what makes
 * `availability` synchronous. A discovery read over a catalog therefore probes every declared
 * option for free, where a per-option resolution meant an `accountOf` read, a configured-providers
 * read and a key LEASE (an atomic select-and-mark write plus a decrypt) each time.
 */
class ScopedInlineUseCaseSession implements InlineUseCaseSession {
  constructor(
    private readonly deps: LlmInlineUseCaseGeneratorDeps,
    private readonly scope: InlineUseCaseScope,
    private readonly provider: ModelProvider | undefined,
  ) {}

  availability(option: InlineUseCaseModelOption): InlineUseCaseModelAvailability {
    const ref = this.refFor(option)
    if (!ref) return { available: false, reason: 'provider_unavailable' }
    if (runsOnSubscriptionHarness(ref) && !this.deps.runsInline?.(ref)) {
      // A subscription harness runs inside a per-run container against a pooled OAuth token. A use
      // case has no container and no run, so this is a permanent property of the pairing rather
      // than a missing credential, and it is reported as its own cause. The test goes through
      // kernel's `runsOnSubscriptionHarness` rather than a local spelling of it, because a ref
      // carrying `harness: 'pi'` is the case a bare truthiness test gets wrong.
      return { available: false, reason: 'container_only' }
    }
    if (!this.provider) return { available: false, reason: 'provider_unavailable' }
    try {
      this.provider.resolve(ref)
    } catch (error) {
      // `resolve` throws for a provider id with no registered resolver, which on this platform means
      // the deployment configured no credentials for it. Logged rather than swallowed: an operator
      // reading "unavailable" on a model they believe they configured needs the resolver's own
      // message, which names what IS registered.
      this.deps.logger?.debug('A use-case model did not resolve', {
        workspaceId: this.scope.workspaceId,
        model: option.id,
        ...describeError(error),
      })
      return { available: false, reason: 'provider_unavailable' }
    }
    return { available: true, ref }
  }

  async generate(request: InlineUseCaseGenerationRequest): Promise<InlineUseCaseGeneration> {
    // Re-checked rather than trusted, and it costs nothing now that the pool is in hand: the port
    // is called by the service AND directly by anything else holding a session, so `generate` owns
    // the same refusal rather than assuming a caller made it.
    const availability = this.availability(request.option)
    if (!availability.available) {
      throw new UnavailableError(
        `The model '${request.option.label}' cannot be served by this deployment`,
        'use_case_model_unavailable',
        { model: request.option.id, cause: availability.reason },
      )
    }
    const provider = this.provider
    if (!provider) {
      throw new UnavailableError(
        'No model provider is configured, so use cases cannot be invoked',
        'use_case_models_unconfigured',
      )
    }
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_USE_CASE_TIMEOUT_MS
    // ONE signal for the whole call, retries included, so the deadline is an absolute expiry rather
    // than a per-attempt one. `aborted` is then what tells a timeout from a vendor error, without
    // sniffing an error shape the SDK is free to change.
    const deadline = AbortSignal.timeout(timeoutMs)
    try {
      const result = await generateText({
        model: provider.resolve(availability.ref),
        system: request.system,
        prompt: request.prompt,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        abortSignal: deadline,
        maxRetries: USE_CASE_MAX_RETRIES,
        // The call is tagged with the use case as its agent kind, so its tokens land in the same
        // rollups every other inline call does and an operator can see what an editor is spending
        // per use case rather than as one undifferentiated "inline" bucket.
        providerOptions: catFactoryObservability({
          agentKind: request.useCaseId,
          workspaceId: this.scope.workspaceId,
        }),
      })
      return {
        text: result.text,
        finishReason: mapFinishReason(result.finishReason),
        usage: readUseCaseUsage(result.usage),
        ref: availability.ref,
      }
    } catch (error) {
      throw this.failed(request, error, deadline.aborted ? timeoutMs : undefined)
    }
  }

  /**
   * The refusal for a call the vendor did not complete.
   *
   * A timeout is its OWN reason rather than one more generation failure, because the caller's move
   * differs: a failed call is worth surfacing to whoever asked, a call that ran out of time is
   * worth retrying with a smaller reply budget. Collapsing them would hide the only one of the two
   * that the caller can do something about.
   */
  private failed(
    request: InlineUseCaseGenerationRequest,
    error: unknown,
    timedOutAfterMs: number | undefined,
  ): UnavailableError {
    const message =
      timedOutAfterMs === undefined
        ? `The use-case model '${request.option.label}' failed: ${getErrorMessage(error)}`
        : `The use-case model '${request.option.label}' did not answer within ${timedOutAfterMs}ms`
    this.deps.logger?.warn(message, {
      workspaceId: this.scope.workspaceId,
      useCaseId: request.useCaseId,
      model: request.option.id,
      ...describeError(error),
    })
    return new UnavailableError(
      message,
      timedOutAfterMs === undefined ? 'use_case_generation_failed' : 'use_case_generation_timeout',
      { model: request.option.id },
    )
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

export class LlmInlineUseCaseGenerator implements InlineUseCaseGenerator {
  constructor(private readonly deps: LlmInlineUseCaseGeneratorDeps) {}

  /** Whether a generation can run at all (some provider is wired). */
  get enabled(): boolean {
    return !!this.deps.modelProviderResolver || !!this.deps.modelProvider
  }

  /**
   * Resolve this request's credential pool ONCE and hand back the session that reads it.
   *
   * Not caught here: a pool that could not be read is a fact about the deployment, and each caller
   * answers it differently (discovery says so per option and still publishes the catalog; an
   * invocation lets it propagate). Swallowing it here would make both of them guess.
   */
  async forScope(scope: InlineUseCaseScope): Promise<InlineUseCaseSession> {
    const provider = await resolveScopedModelProvider(modelScopeFor(scope), this.deps)
    return new ScopedInlineUseCaseSession(this.deps, scope, provider)
  }
}
