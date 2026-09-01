import type { LanguageModelMiddleware } from 'ai'
import type { LanguageModel } from 'ai'
import type {
  InlineLlmCallRecorder,
  InlineObservabilityContext,
  LlmGenerationEvent,
  LlmTraceSink,
  Logger,
  ModelProvider,
  ModelRef,
  StoreAgentContextGate,
} from '@cat-factory/kernel'
import {
  catFactoryObservability,
  describeError,
  getErrorMessage,
  noopLogger,
  redactImagePayloads,
  resolveInlineAttribution,
  runBestEffort,
} from '@cat-factory/kernel'
import { reportsOwnLlmCalls } from './cli-inline.js'
import { readMetadataGatewayReport, type GatewayCallReport } from './gateway-attribution.js'
import { wrapModelPreservingMarkers } from './model-markers.js'

/**
 * Whether prompt/response BODIES may leave this workspace for a trace sink — the
 * per-workspace `storeAgentContext` opt-out, passed in as a narrow predicate so this package
 * needs no persistence dependency.
 *
 * The type and its one implementation are kernel's `StoreAgentContextGate` /
 * `createStoreAgentContextGate`: the proxied path applies the SAME rule, and a second name
 * for it here is how the two came to state it differently in the first place (C2). Aliased
 * rather than redeclared so a change to the rule reaches both paths.
 *
 * `null` is an inline call carrying no workspace tag: there is no workspace whose opt-out
 * could apply, so the deployment switch alone governs it. That is a reason to TAG the call,
 * not to guess — every first-party inline site passes its `workspaceId`.
 */
export type WorkspaceBodiesGate = StoreAgentContextGate

// Re-exported so existing `@cat-factory/agents` consumers keep importing the inline
// observability tag from here; the canonical, dependency-free definition lives in the
// kernel so any caller layer can build the tag without depending on this package.
export { catFactoryObservability }
export type { InlineObservabilityContext }

// Instruments the INLINE (non-proxied) LLM calls so they reach the SAME sinks as the
// container-agent calls. Container calls go through the LLM proxy (or, on a subscription
// harness, the harness's own stream), and both feed the orchestration
// `LlmObservabilityService`, which persists the call to `llm_call_metrics` and fans it out
// to the external trace sink. Inline calls (requirements review/rework, the document
// researcher/outliner/interviewer, the judges, consensus, the fragment selector, the inline
// agent executor) call the AI SDK directly. This decorator wraps every resolved model with an
// AI SDK middleware that, after each generate, feeds the same telemetry through one of two
// exits — so adding the inline feeder never means a second sink OR a second store:
//
//   - `recordCall` (preferred) — the {@link InlineLlmCallRecorder} the facade builds off
//     `LlmObservabilityService`. It persists the row AND owns the trace-sink fan-out, so an
//     inline call recorded this way is visible to `ObservabilityPanel`, the per-step token
//     rollups and `/api/v1/debug/*` exactly like a proxied one. Requires a workspace to file
//     the row under.
//   - `traceSink` — the direct emit, for a deployment that wires a sink but no metric store,
//     and for the un-tagged call `recordCall` structurally cannot take (see below).
//
// EXACTLY ONE of the two runs per call. `recordCall`'s service already fans out to the sink
// it was built with, so calling both would double every inline generation on Langfuse/OTel;
// the facade therefore hands the SAME sink instance to both.
//
// The middleware is transparent: callers keep calling `generateText({ model })`
// unchanged. To group a call under its run's trace and label it, a caller passes
// `providerOptions: catFactoryObservability({ agentKind, workspaceId, executionId })`
// (the kernel helper); absent ⇒ the call still emits, as its own standalone trace
// named `inline`. The instrumentation never changes the model's behaviour and never
// throws into the call.

/** Read token counts defensively across the AI SDK's flat (v2) and nested (v3) usage shapes. */
/**
 * Read the SDK's usage into the four orthogonal classes the trace sink carries: `prompt` is
 * FRESH input only, with the two cache classes beside it, so
 * `prompt + cacheRead + cacheWrite` is the total input.
 *
 * The v3 shape already breaks the input down (`{ total, noCache, cacheRead, cacheWrite }`),
 * so the split is read straight off it rather than re-derived; `noCache` is preferred over
 * `total − read − write` because it is what the provider itself reported, and the subtraction
 * is only the fallback for a model that fills `total` but not `noCache`. The v2/flat shape
 * carries no cache breakdown at all, so both classes are 0 and the flat prompt count is
 * already the whole (uncached) input.
 */
function readUsage(usage: unknown): {
  prompt: number
  cacheRead: number
  cacheWrite: number
  completion: number
  total: number
} {
  const u = usage as Record<string, unknown> | undefined
  if (!u) return { prompt: 0, cacheRead: 0, cacheWrite: 0, completion: 0, total: 0 }
  const inputTokens = u.inputTokens
  const outputTokens = u.outputTokens
  const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
  // v3: nested { total, noCache, cacheRead, cacheWrite }
  if (inputTokens && typeof inputTokens === 'object') {
    const input = inputTokens as {
      total?: number
      noCache?: number
      cacheRead?: number
      cacheWrite?: number
    }
    const cacheRead = num(input.cacheRead)
    const cacheWrite = num(input.cacheWrite)
    const prompt =
      typeof input.noCache === 'number'
        ? input.noCache
        : Math.max(0, num(input.total) - cacheRead - cacheWrite)
    const completion = Number((outputTokens as { total?: number })?.total ?? 0)
    const total =
      typeof u.totalTokens === 'number'
        ? u.totalTokens
        : prompt + cacheRead + cacheWrite + completion
    return { prompt, cacheRead, cacheWrite, completion, total }
  }
  // v2 / legacy flat: no cache breakdown reported.
  const prompt = Number((inputTokens as number) ?? (u.promptTokens as number) ?? 0)
  const completion = Number((outputTokens as number) ?? (u.completionTokens as number) ?? 0)
  const total = typeof u.totalTokens === 'number' ? u.totalTokens : prompt + completion
  return { prompt, cacheRead: 0, cacheWrite: 0, completion, total }
}

/** Extract the assistant text from a generate result, across result shapes. */
function readOutputText(result: unknown): string {
  const r = result as { text?: unknown; content?: unknown }
  if (typeof r?.text === 'string') return r.text
  if (Array.isArray(r?.content)) {
    return r.content
      .filter((part) => (part as { type?: string })?.type === 'text')
      .map((part) => String((part as { text?: unknown }).text ?? ''))
      .join('')
  }
  return ''
}

/** Extract the model's reasoning/thinking trace from a generate result, when it came separately. */
function readReasoningText(result: unknown): string {
  const content = (result as { content?: unknown })?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => (part as { type?: string })?.type === 'reasoning')
    .map((part) => String((part as { text?: unknown }).text ?? ''))
    .join('')
}

/** How many chat messages the request carried (the store's chain uses this as the turn size). */
function readMessageCount(params: unknown): number {
  const prompt = (params as { prompt?: unknown })?.prompt
  return Array.isArray(prompt) ? prompt.length : 0
}

/** How many tools the request offered, across the SDK's array and record `tools` shapes. */
function readToolCount(params: unknown): number {
  const tools = (params as { tools?: unknown })?.tools
  if (Array.isArray(tools)) return tools.length
  if (tools && typeof tools === 'object') return Object.keys(tools).length
  return 0
}

/** The output ceiling the request asked for, or null when it named none. */
function readRequestMaxTokens(params: unknown): number | null {
  const max = (params as { maxOutputTokens?: unknown })?.maxOutputTokens
  return typeof max === 'number' ? max : null
}

/**
 * The call's finish reason, across the SDK's two shapes.
 *
 * The current (v3) spec reports an OBJECT — `{ unified, raw? }` — where `unified` is the
 * provider-independent reason and `raw` whatever the vendor called it; only the older flat
 * spec reports the bare string. Reading the string alone silently answered `null` for every
 * real call, which is invisible in telemetry (a null finish reason reads as "the provider
 * didn't say") and is why this has a test driving the SDK's own mock model rather than a
 * hand-rolled stand-in that returned the shape the reader wanted.
 *
 * `unified` is the one stored: it is what makes `length` comparable across providers, which
 * is the whole reason a truncated-output signal can be computed at all.
 *
 * `other` with NO `raw` is read as NOTHING REPORTED. The unified union is closed and has no
 * "unknown" member, so `other` is the only thing a model can answer when its backend named no stop
 * reason at all — which is every call a subscription CLI serves (`CliInlineLanguageModel`, whose own
 * rows record null). Storing the placeholder here made the same absence read as two different values
 * in two stores, the trace sink claiming a classification nobody made. A vendor string in `raw` is
 * what distinguishes a real `other` from that, so it is kept.
 */
function readFinishReason(result: unknown): string | null {
  const reason = (result as { finishReason?: unknown })?.finishReason
  if (typeof reason === 'string') return reason
  const object = reason as { unified?: unknown; raw?: unknown } | undefined
  const unified = object?.unified
  if (typeof unified !== 'string') return null
  return unified === 'other' && typeof object?.raw !== 'string' ? null : unified
}

/**
 * A {@link ModelProvider} that wraps every resolved model so inline LLM calls surface on the
 * telemetry store and/or the external trace sink. Build it only when at least one of those
 * exits is wired AND the deployment opts in; an unwrapped provider behaves exactly as before.
 */
export class InstrumentedModelProvider implements ModelProvider {
  private readonly inner: ModelProvider
  private readonly traceSink?: LlmTraceSink
  private readonly recordCall?: InlineLlmCallRecorder
  private readonly recordPrompts: boolean
  private readonly workspaceBodiesEnabled: WorkspaceBodiesGate
  private readonly scopeExecutionId: string | null
  private readonly now: () => number
  private readonly log: Logger

  constructor(deps: {
    inner: ModelProvider
    /**
     * The external trace sink (Langfuse / OTel). Used for a call {@link recordCall} cannot
     * take, and as the sole exit on a deployment with a sink but no metric store. When both
     * are wired this MUST be the same instance the recorder's service fans out to, or the
     * two exits describe the same generation to the sink differently.
     */
    traceSink?: LlmTraceSink
    /**
     * Persist each workspace-scoped inline call to `llm_call_metrics` (and, through the
     * service behind it, to the trace sink). Wired wherever the facade has a metric store —
     * without it the inline half of the platform's model activity is invisible to every
     * in-app observability surface, which is the gap this exists to close.
     */
    recordCall?: InlineLlmCallRecorder
    /** Honour the same `LLM_RECORD_PROMPTS` switch as the local store; default true. */
    recordPrompts?: boolean
    /**
     * The per-workspace `storeAgentContext` opt-out, the SECOND half of the double gate the
     * proxy path applies (`LlmObservabilityService.bodiesEnabled`). REQUIRED, not optional:
     * this path shipped for months honouring only the deployment switch, so an opted-out
     * workspace's inline prompts and responses still reached Langfuse/OTel — a privacy bug,
     * not a coverage gap (observability-logging-gaps.md, C2). An absent optional gate is
     * open by definition, which is exactly the failure mode; requiring it makes forgetting
     * one a typecheck failure instead of a silent leak.
     *
     * Applies to the {@link traceSink} exit only: a call taken by {@link recordCall} is
     * gated INSIDE the service, by the very same rule from the very same kernel factory, so
     * re-applying it here would only create a second place for the rule to drift.
     */
    workspaceBodiesEnabled: WorkspaceBodiesGate
    /**
     * The run this provider's SCOPE was built for, used as the attribution fallback when a
     * call's own `catFactoryObservability` tag names no `executionId`.
     *
     * Every run-scoped inline caller already resolves the block's active run into its
     * {@link ModelScope} — it has to, or a facade serving a subscription ref through a
     * per-run credential activation could not lease it. The per-call tag is the same fact
     * stated a second time, and ten of the twelve inline sites stated only the workspace:
     * their rows landed with `execution_id = NULL`, which is not "unrecorded" but something
     * worse to debug — present in the store and absent from every run-scoped read
     * (`listByExecution` / `summarizeByExecution`, a step's token rollup,
     * `/api/v1/debug/runs/*`). Deriving it from the credential scope makes the attribution
     * unforgettable instead of a rule each new inline site must remember.
     *
     * The tag still WINS where a caller sets it: a scope is per-provider while a tag is
     * per-call, so a caller that knows better (consensus, which fans one scope out across
     * participants) must be able to say so. Absent on both ⇒ null, the honest answer for a
     * genuinely un-run-scoped call (the document planner, a bug-hunt rating, a fragment
     * title) — never guessed at from anything else.
     */
    scopeExecutionId?: string
    /** Injectable clock (tests); defaults to `Date.now`. */
    now?: () => number
    /** Where a dropped inline export reports itself. Absent ⇒ `noopLogger`. */
    logger?: Logger
  }) {
    if (!deps.traceSink && !deps.recordCall) {
      // A provider that instruments nothing is a wiring mistake wearing the instrumented
      // wrapper's clothes: every call would pay the middleware and reach no sink, and the
      // facade's `instanceof InstrumentedModelProvider` wiring assertions would still pass.
      throw new Error(
        'InstrumentedModelProvider needs at least one exit: a traceSink, a recordCall, or both.',
      )
    }
    this.inner = deps.inner
    this.traceSink = deps.traceSink
    this.recordCall = deps.recordCall
    this.recordPrompts = deps.recordPrompts ?? true
    this.workspaceBodiesEnabled = deps.workspaceBodiesEnabled
    this.scopeExecutionId = deps.scopeExecutionId ?? null
    this.now = deps.now ?? (() => Date.now())
    this.log = (deps.logger ?? noopLogger).child({ scope: 'inlineLlmTrace' })
  }

  resolve(ref: ModelRef): LanguageModel {
    const model = this.inner.resolve(ref)
    // The wrap only accepts a model instance (not a model-id string). A bare
    // string ref would be unusual for inline kinds, but pass it through untouched. The
    // base resolvers return current-spec (v3) models; the cast bridges the broader
    // `LanguageModel` union to the wrap's exact model param.
    if (typeof model === 'string') return model
    // A model that files its own per-call rows is left UNWRAPPED: it is behind a harness CLI
    // that runs a whole tool loop per `doGenerate`, so it knows the calls this middleware
    // cannot see, and wrapping it too would add one lumped duplicate to every step's rollup.
    // See `reportsOwnLlmCalls` for why the model is asked rather than the facade told.
    if (reportsOwnLlmCalls(model)) return model
    // Marker-preserving, because a wrap erases every declaration the model carries and the
    // limiter above this one is not the last reader: the executor reads the BILLING marker off
    // whatever comes back. See `model-markers.ts`.
    return wrapModelPreservingMarkers({
      model: model as Parameters<typeof wrapModelPreservingMarkers>[0]['model'],
      middleware: this.middlewareFor(ref),
    })
  }

  private middlewareFor(ref: ModelRef): LanguageModelMiddleware {
    return {
      specificationVersion: 'v3',
      wrapGenerate: async ({ doGenerate, params }) => {
        const startedAt = this.now()
        try {
          const result = await doGenerate()
          this.emit(ref, params, result, startedAt, true, null)
          return result
        } catch (err) {
          this.emit(ref, params, undefined, startedAt, false, getErrorMessage(err))
          throw err
        }
      },
    }
  }

  private emit(
    ref: ModelRef,
    params: unknown,
    result: unknown,
    startedAt: number,
    ok: boolean,
    errMessage: string | null,
  ): void {
    const endedAt = this.now()
    // The call's own tag first, then the credential scope this provider was built for — the ONE
    // shared precedence, because a self-reporting model files rows through the same rule (see
    // `resolveInlineAttribution`). Only the RUN half of the scope is offered: an untagged call
    // deliberately falls through to the sink below rather than being filed under the scope's
    // workspace, which is a reason for a caller to tag its call and not for this to guess.
    const { workspaceId, executionId, agentKind } = resolveInlineAttribution(
      params,
      this.scopeExecutionId ? { executionId: this.scopeExecutionId } : {},
    )
    const usage = readUsage((result as { usage?: unknown })?.usage)
    // Only a SETTLED call can carry a gateway report; a throw has no result to read one off.
    const gateway = ok ? readMetadataGatewayReport(result) : {}
    const finishReason = ok ? readFinishReason(result) : null
    // The recorder is the richer exit AND owns the sink fan-out, so a workspace-scoped call
    // takes it and stops. An un-tagged call (`workspaceId: null`) has no workspace to file a
    // row under, so it falls through to the sink — which is also the whole story on a
    // deployment that wires a sink but retains no metrics.
    if (this.recordCall && workspaceId) {
      this.record(this.recordCall, {
        workspaceId,
        executionId,
        agentKind,
        ref,
        params,
        result,
        usage,
        gateway,
        durationMs: Math.max(0, endedAt - startedAt),
        finishReason,
        ok,
        errMessage,
      })
      return
    }
    if (!this.traceSink) return
    const traceSink = this.traceSink
    // Numeric telemetry + timing are recorded unconditionally, exactly as on the proxy
    // path; only the BODIES answer to the privacy gate below.
    const event: Omit<LlmGenerationEvent, 'input' | 'output'> = {
      workspaceId,
      executionId,
      agentKind,
      provider: ref.provider,
      model: ref.model,
      startedAt,
      endedAt,
      promptTokens: usage.prompt,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      completionTokens: usage.completion,
      totalTokens: usage.total,
      finishReason,
      ok,
      errorMessage: errMessage,
    }
    // Best-effort and fully isolated — instrumentation must never break the LLM call.
    // `runBestEffort` covers the synchronous build/dispatch throw as well as the rejection,
    // which is what the `try` around the old `.catch(() => {})` was there for.
    void runBestEffort(
      this.log,
      'traceSink.recordGeneration',
      async () => {
        // Resolved per call, not once when the provider was built, so a workspace that
        // turns `storeAgentContext` off stops shipping bodies on its very next inline
        // call rather than when its scoped provider is next rebuilt.
        const recordBodies = await this.bodiesAllowed(workspaceId)
        await traceSink.recordGeneration({
          ...event,
          input: recordBodies ? safeJson((params as { prompt?: unknown })?.prompt) : '',
          output: recordBodies && ok ? readOutputText(result) : '',
        })
      },
      { workspaceId, executionId: event.executionId, source: 'inline' },
    )
  }

  /**
   * Hand a workspace-scoped call to the metric recorder. Bodies are passed through
   * UNGATED on purpose: the service behind the recorder scrubs them and applies the same
   * `LLM_RECORD_PROMPTS` + `storeAgentContext` double gate this class applies to the sink
   * exit — gating here as well would drop a body the service is entitled to store and put
   * the rule in two places, which is how the sink half drifted open in the first place.
   * They are handed over as THUNKS so keeping the gate on the far side costs nothing: a
   * deployment with recording off never pays to serialise the prompt array.
   *
   * Best-effort and off the response path, exactly like the sink exit.
   */
  private record(
    recordCall: InlineLlmCallRecorder,
    call: {
      workspaceId: string
      executionId: string | null
      agentKind: string
      ref: ModelRef
      params: unknown
      result: unknown
      usage: ReturnType<typeof readUsage>
      gateway: GatewayCallReport
      durationMs: number
      finishReason: string | null
      ok: boolean
      errMessage: string | null
    },
  ): void {
    const { workspaceId, executionId, ref, params, result, usage, ok } = call
    void runBestEffort(
      this.log,
      'llmObservability.recordInlineCall',
      () =>
        recordCall({
          workspaceId,
          executionId,
          agentKind: call.agentKind,
          provider: ref.provider,
          model: ref.model,
          messageCount: readMessageCount(params),
          toolCount: readToolCount(params),
          requestMaxTokens: readRequestMaxTokens(params),
          promptTokens: usage.prompt,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
          completionTokens: usage.completion,
          totalTokens: usage.total,
          finishReason: call.finishReason,
          durationMs: call.durationMs,
          ok,
          errorMessage: call.errMessage,
          ...(call.gateway.cost === undefined ? {} : { reportedCostUsd: call.gateway.cost }),
          ...(call.gateway.upstream === undefined
            ? {}
            : { upstreamProvider: call.gateway.upstream }),
          // Thunks: the service resolves a body only after its gate says it will be stored,
          // so a prompts-off deployment never serialises a prompt array it then drops.
          promptText: () => safeJson((params as { prompt?: unknown })?.prompt),
          responseText: () => (ok ? readOutputText(result) : ''),
          reasoningText: () => (ok ? readReasoningText(result) : ''),
        }),
      { workspaceId, executionId, source: 'inline' },
    )
  }

  /**
   * The double gate on prompt/response bodies: the deployment-wide `LLM_RECORD_PROMPTS`
   * switch AND the workspace's own `storeAgentContext` opt-out.
   *
   * FAILS CLOSED. An unreadable settings row is not consent, so a store hiccup withholds
   * the bodies rather than defaulting to "allowed" — but it must not cost the whole export,
   * so the numeric telemetry still ships. Reported rather than swallowed: a gate that is
   * permanently unreadable would otherwise present as a deployment that quietly stopped
   * tracing bodies at all.
   */
  private async bodiesAllowed(workspaceId: string | null): Promise<boolean> {
    if (!this.recordPrompts) return false
    try {
      return await this.workspaceBodiesEnabled(workspaceId)
    } catch (error) {
      this.log.warn('workspace body-recording gate unreadable; withholding bodies', {
        ...describeError(error),
        workspaceId,
      })
      return false
    }
  }
}

/**
 * Serialise a recorded body, with any image payload replaced by a description of itself.
 *
 * The redaction is not a nicety: a multimodal turn carries the picture as a `Uint8Array` in the
 * SDK's own message shape, and a typed array JSON-stringifies to one entry per byte — several
 * megabytes of `{"0":137,…}` per recorded call, on every turn of a run that attached a design.
 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(redactImagePayloads(value ?? []))
  } catch {
    return ''
  }
}
