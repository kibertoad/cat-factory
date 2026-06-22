// Optional, opt-in sink for streaming LLM activity to an external observability
// platform (e.g. Langfuse). It is the SINGLE code path that both LLM feeders reach:
//
//  - the runtime-neutral LLM proxy (container agent calls) — the orchestration
//    `LlmObservabilityService` fans every metered call out here after persisting it;
//  - the inline (non-proxied) LLM calls (the requirements reviewer/rework, the
//    document planner, the fragment selector, the inline agent executor) — an
//    `InstrumentedModelProvider` wraps every resolved model so each `generateText`
//    surfaces the same {@link LlmGenerationEvent} here.
//
// Both build the identical {@link LlmGenerationEvent} and call {@link
// LlmTraceSink.recordGeneration}, so adding a second feeder never means a second
// sink. The port is implemented by an opt-in package (`@cat-factory/observability-langfuse`)
// and wired into a facade only when configured; absent ⇒ no external emission and no
// behaviour change. A sink MUST NOT throw into its caller (LLM work must never break
// because observability is down) — implementations swallow + log their own errors, and
// callers additionally schedule the call off the response path.

/** One completed LLM call (proxied or inline), normalised for an external trace. */
export interface LlmGenerationEvent {
  /** The workspace the call ran for, or null when not in a workspace scope. */
  workspaceId: string | null
  /**
   * The run this call belongs to, used to group every call of a run under one trace.
   * Null for inline single-shot calls (requirements review / doc planner / fragment
   * selection), which then become their own standalone trace.
   */
  executionId: string | null
  /** The agent kind / call site (`coder`, `merger`, `requirements-review`, …). */
  agentKind: string
  provider: string
  model: string
  /** Epoch ms the call started (upstream dispatch). */
  startedAt: number
  /** Epoch ms the call completed. */
  endedAt: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Upstream finish reason (`stop` | `length` | `tool_calls` | …), or null. */
  finishReason: string | null
  /** Whether the call succeeded. */
  ok: boolean
  /** A short error message when {@link ok} is false, else null. */
  errorMessage: string | null
  /**
   * The request messages serialised as JSON (the FULL prompt, not a delta), or empty
   * when prompt recording is disabled (`LLM_RECORD_PROMPTS=false`) — the same privacy
   * switch the local metric store honours.
   */
  input: string
  /** The full assistant response text, or empty when prompt recording is disabled. */
  output: string
}

/**
 * One tool invocation inside a container agent's loop, captured by the harness and
 * drained by the backend on its existing job poll, then emitted as a child span under
 * the run's trace. Metadata only (never tool args/results) so the harness buffer stays
 * tiny and bounded.
 */
export interface LlmToolSpan {
  /** The tool name (`edit_file`, `run_command`, `todo`, …). */
  tool: string
  /** Epoch ms the tool call started. */
  startedAt: number
  /** Epoch ms the tool call ended. */
  endedAt: number
  /** Whether the tool call succeeded. */
  ok: boolean
}

/** Scope a batch of {@link LlmToolSpan tool spans} to the run that produced them. */
export interface LlmToolSpanContext {
  workspaceId: string | null
  executionId: string | null
  agentKind: string
}

export interface LlmTraceSink {
  /** Emit one completed LLM call as a generation under its run's trace. */
  recordGeneration(event: LlmGenerationEvent): Promise<void> | void
  /**
   * Emit a drained batch of container tool spans as child spans under the run trace.
   * Optional: a sink that only cares about generations can omit it.
   */
  recordToolSpans?(context: LlmToolSpanContext, spans: LlmToolSpan[]): Promise<void> | void
}
