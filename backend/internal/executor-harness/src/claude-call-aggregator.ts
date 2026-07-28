import { claudeAssistantContent, claudeCallUsage, isObject, redactBody } from './claude-stream.js'
import type { HarnessCallMetric } from './pi.js'

// Claude Code's `stream-json` does NOT emit one `assistant` envelope per model call. It emits one
// per CONTENT BLOCK of a call's response — a turn that answers with text and then fires five
// parallel tool calls arrives as six envelopes, each carrying that ONE call's `usage`, with the
// `user` tool_result turns interleaved between them. Treating an envelope as a call therefore
// counted a single request once per block: a measured pr-review recorded 575 rows and 39.4M summed
// prompt tokens for ~230 real calls and ~16.3M, which is why the burn instrumentation could not be
// trusted (docs/initiatives/token-burn-instrumentation.md).
//
// This aggregator folds every envelope sharing a `message.id` back into the one call it belongs to,
// and buffers that call's tool_result turns so the reconstructed prompt chain keeps the shape the
// model was actually sent: one assistant turn holding all its blocks, then the results.

/** One model call, assembled from every stream envelope that carried a piece of it. */
export interface AggregatedClaudeCall {
  model?: string
  /** Every content block of the response, in arrival order. */
  content: unknown[]
  text: string
  reasoning: string
  stopReason: string | null
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  /** The `user` turns carrying this call's tool_result blocks, in arrival order. */
  toolResults: unknown[][]
  /** tool_use blocks across the whole response (the run's `stats.toolCalls` term). */
  toolUses: number
}

export interface ClaudeCallAggregator {
  /**
   * Fold one `assistant` envelope in. A new `message.id` completes the call in flight first, so
   * `onCallStart` for the new call always runs after `onCall` for the previous one.
   */
  onAssistant(message: Record<string, unknown>): void
  /** Buffer a `user` turn's content against the call in flight (dropped when none is). */
  onToolResult(content: unknown[]): void
  /** Complete the call still in flight, if any. Call once the stream has ended. */
  flush(): void
}

interface Pending extends AggregatedClaudeCall {
  id: string
}

/**
 * Assemble per-call telemetry out of Claude Code's per-block stream envelopes.
 *
 * `onCallStart` fires when a call's FIRST envelope arrives, which is the moment the caller must
 * snapshot the prompt: the history at that point is what produced the response. `onCall` fires
 * once the call is complete (a different `message.id` began, or the stream ended).
 *
 * Usage is merged as the MAXIMUM of each bucket across the call's envelopes rather than the last
 * one seen. The envelopes carry a snapshot of the same call's usage, and which of them holds the
 * final output count is a CLI detail we should not depend on; a max is right whether the value is
 * repeated verbatim or grows.
 *
 * An envelope with no `message.id` cannot be attributed, so it is treated as a call of its own —
 * the pre-aggregation behaviour, kept so a CLI build (or a transcript) that omits the id degrades
 * to over-counting rather than to silently merging unrelated calls.
 */
export function createClaudeCallAggregator(handlers: {
  onCallStart?: () => void
  onCall: (call: AggregatedClaudeCall) => void
}): ClaudeCallAggregator {
  let pending: Pending | undefined
  let anonymous = 0

  const complete = (): void => {
    if (!pending) return
    const { id: _id, ...call } = pending
    pending = undefined
    handlers.onCall(call)
  }

  return {
    onAssistant(message) {
      // `#anon-<n>` cannot collide with a real id (the API mints `msg_…`), so an envelope
      // with no id keeps its own call rather than merging into whatever came before it.
      const id = typeof message.id === 'string' && message.id ? message.id : `#anon-${anonymous++}`
      if (pending && pending.id !== id) complete()
      const content = Array.isArray(message.content) ? message.content : []
      const { text, reasoning, toolUses } = claudeAssistantContent(content)
      const usage = claudeCallUsage(message.usage)
      const stopReason = typeof message.stop_reason === 'string' ? message.stop_reason : null
      const model = typeof message.model === 'string' ? message.model : undefined
      if (!pending) {
        pending = {
          id,
          content: [],
          text: '',
          reasoning: '',
          stopReason: null,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          toolResults: [],
          toolUses: 0,
        }
        handlers.onCallStart?.()
      }
      pending.content.push(...content)
      pending.text += text
      pending.reasoning += reasoning
      pending.toolUses += toolUses
      pending.inputTokens = Math.max(pending.inputTokens, usage.inputTokens)
      pending.cacheReadTokens = Math.max(pending.cacheReadTokens, usage.cacheReadTokens)
      pending.cacheWriteTokens = Math.max(pending.cacheWriteTokens, usage.cacheWriteTokens)
      pending.outputTokens = Math.max(pending.outputTokens, usage.outputTokens)
      // A block-split response reports its stop reason on the envelope that carries the end of the
      // message; earlier ones report none. Keep the first non-null rather than the last seen.
      if (stopReason && !pending.stopReason) pending.stopReason = stopReason
      if (model && !pending.model) pending.model = model
    },

    onToolResult(content) {
      // Results can only belong to the tool_use blocks of the call in flight. Before the first
      // assistant envelope there is nothing they could attach to.
      if (pending) pending.toolResults.push(content)
    },

    flush: complete,
  }
}

/** One turn of the reconstructed request transcript, in the proxy's chat-array shape. */
interface TranscriptTurn {
  role: string
  content: unknown
}

/** The per-call telemetry the Claude Code stream yields, assembled behind one small surface. */
export interface ClaudeStreamTelemetry {
  /** Fold an `assistant` envelope in (parent-loop turns only — see {@link isSubagentEvent}). */
  onAssistant(message: Record<string, unknown>): void
  /** Fold a `user` turn's tool_result content in, against the call in flight. */
  onToolResult(content: unknown[]): void
  /** Publish the call still in flight. Idempotent; safe to call on both the clean and error path. */
  flush(): void
}

/**
 * Assemble ONE conversation's per-call telemetry from the CLI stream: the growing request
 * transcript and the per-call token/body metrics.
 *
 * Owns the transcript because the two are one concern — a call's `promptText` is the transcript as
 * of that call, and its turns may only be appended once the call that produced them is complete.
 * `seed` is what the harness supplied and the stream therefore never shows (the system + first user
 * message, or the single folded user turn), so the reconstruction never claims a system turn that
 * was not sent. A subagent's conversation seeds EMPTY — its prompt was minted by the CLI and never
 * crosses this stream — which is also why its first call carries `messageCount: 0` (the backend's
 * `latestChainTip` skips those on purpose: there is no re-sendable chain to delta against).
 * Bodies are credential-scrubbed; they can echo the leased token.
 *
 * Deliberately does NOT touch {@link PiRunStats}: the run's tool/output counters describe whether
 * the agent ACTED at all (`agentNeverActed`), which is true of a subagent's turns whichever channel
 * ends up owning their telemetry rows. The caller accumulates them off the raw stream instead.
 */
export function createClaudeStreamTelemetry(opts: {
  seed: TranscriptTurn[]
  secrets: string[]
  publish: (metric: HarnessCallMetric) => void
}): ClaudeStreamTelemetry {
  const messages: TranscriptTurn[] = [...opts.seed]
  let callPrompt = ''
  let callMessageCount = 0

  // The aggregator IS the surface: the transcript and metric work happens in its callbacks, so
  // there is nothing to wrap it in.
  return createClaudeCallAggregator({
    // Snapshotted when a call's FIRST envelope arrives: the history at that moment is what
    // produced the response, and later envelopes of the same call must not see the turns it
    // went on to add.
    onCallStart: () => {
      callPrompt = redactBody(JSON.stringify(messages), opts.secrets)
      callMessageCount = messages.length
    },
    onCall: (call) => {
      opts.publish({
        ...(call.model ? { model: call.model } : {}),
        promptText: callPrompt,
        messageCount: callMessageCount,
        responseText: redactBody(call.text, opts.secrets),
        reasoningText: redactBody(call.reasoning, opts.secrets),
        inputTokens: call.inputTokens,
        cacheReadTokens: call.cacheReadTokens,
        cacheWriteTokens: call.cacheWriteTokens,
        outputTokens: call.outputTokens,
        finishReason: call.stopReason,
      })
      // Appended only now, so each call's prompt stays a strict prefix of the next and the
      // backend's telemetry chain delta-compresses cleanly.
      messages.push({ role: 'assistant', content: call.content })
      for (const result of call.toolResults) messages.push({ role: 'tool', content: result })
    },
  })
}

/**
 * The dispatch (`Agent`/`Task` tool_use) id a stream envelope is tagged with, or `undefined` for a
 * parent-loop turn.
 *
 * Claude Code streams the turns of the subagents it dispatches onto the parent's stdout, tagged
 * with the tool_use id that spawned them. Those same turns are also written to the per-session
 * `subagents/*.jsonl` transcripts the watcher reads, so recording both channels counted every
 * subagent call twice — and splicing them into the parent's message reconstruction produced a
 * `promptText` chain that interleaves several conversations and therefore matches no real request.
 *
 * The id is what makes the fallback below possible: concurrent subagents interleave on one stdout,
 * so it is the ONLY thing separating their conversations.
 */
export function subagentDispatchId(event: Record<string, unknown>): string | undefined {
  if (!isObject(event)) return undefined
  const id = event.parent_tool_use_id
  return typeof id === 'string' && id ? id : undefined
}

/** Whether a stream envelope describes a SUBAGENT's turn rather than the parent loop's. */
export function isSubagentEvent(event: Record<string, unknown>): boolean {
  return subagentDispatchId(event) !== undefined
}

/**
 * Per-call telemetry for the subagents whose turns ride the parent's stdout — the FALLBACK channel,
 * used only when no `subagents/*.jsonl` watcher will run (see `startSubagentWatcher`, which is
 * wired only when the CLI has an isolated config home; an `ambientAuth` run has none).
 *
 * Without this, filtering tagged events out of the parent's telemetry leaves a subagent-heavy run
 * with its spend recorded by NEITHER channel — an under-count, which reads as a cheap run and is
 * the worse failure direction than the double-count the filter exists to fix.
 *
 * Each dispatch id gets its OWN transcript, because concurrent subagents interleave arbitrarily on
 * one stream: folding them into a single chain is exactly the defect this whole module removes,
 * one level down.
 */
function createSubagentStreamTelemetry(opts: {
  secrets: string[]
  publish: (metric: HarnessCallMetric) => void
}): {
  onAssistant(dispatchId: string, message: Record<string, unknown>): void
  onToolResult(dispatchId: string, content: unknown[]): void
  flush(): void
} {
  const perDispatch = new Map<string, ClaudeStreamTelemetry>()
  const forDispatch = (dispatchId: string): ClaudeStreamTelemetry => {
    let telemetry = perDispatch.get(dispatchId)
    if (!telemetry) {
      // Seeded EMPTY: the CLI minted this subagent's prompt and it never crossed the stream.
      telemetry = createClaudeStreamTelemetry({
        seed: [],
        secrets: opts.secrets,
        publish: opts.publish,
      })
      perDispatch.set(dispatchId, telemetry)
    }
    return telemetry
  }
  return {
    onAssistant: (dispatchId, message) => forDispatch(dispatchId).onAssistant(message),
    // Only against a dispatch already seen: a result for a subagent whose assistant turns never
    // reached us has no conversation to attach to, and minting one would publish a call that is
    // all tool output and no request.
    onToolResult: (dispatchId, content) => perDispatch.get(dispatchId)?.onToolResult(content),
    flush: () => {
      for (const telemetry of perDispatch.values()) telemetry.flush()
    },
  }
}

/** All per-call telemetry for ONE claude-code run: the parent loop, and whoever bills the subagents. */
export interface ClaudeRunTelemetry {
  /** Fold an `assistant` envelope in, routed by its dispatch tag (`undefined` ⇒ the parent loop). */
  onAssistant(dispatchId: string | undefined, message: Record<string, unknown>): void
  /** Fold a `user` turn's tool_result content in, against the same conversation. */
  onToolResult(dispatchId: string | undefined, content: unknown[]): void
  /** Publish every conversation's call in flight. Idempotent; safe on the clean and error paths. */
  flush(): void
  /**
   * Subagent turns crossed the stream AND the watcher was the channel meant to record them — so a
   * watcher that captured nothing means this run's subagent rows are simply missing.
   */
  expectsWatcherCalls(): boolean
}

/**
 * Assemble a run's per-call telemetry, routing each envelope to the conversation it belongs to.
 *
 * The routing is the whole point. A subagent's turns ride the parent's stdout tagged with the
 * dispatch that spawned them, and they must never join the PARENT's chain — that splice produced a
 * `promptText` interleaving several conversations, matching no request that was ever sent.
 *
 * Who RECORDS them is a separate question, decided once per run rather than per event:
 * `watcherOwnsSubagents` says a `subagents/*.jsonl` watcher will run, and it is the better source
 * (it reads the settled transcript, so its usage and stop reason are final). With no watcher — an
 * `ambientAuth` run has no isolated config home to watch — the tagged turns are recorded here
 * instead, on per-dispatch transcripts of their own. Dropping them in that case would leave the run
 * billed by neither channel, and an under-count reads as a cheap run rather than as an error.
 */
export function createClaudeRunTelemetry(opts: {
  seed: TranscriptTurn[]
  secrets: string[]
  watcherOwnsSubagents: boolean
  publish: (metric: HarnessCallMetric) => void
}): ClaudeRunTelemetry {
  const parent = createClaudeStreamTelemetry(opts)
  const subagents = opts.watcherOwnsSubagents ? undefined : createSubagentStreamTelemetry(opts)
  let sawSubagentTurn = false

  return {
    onAssistant(dispatchId, message) {
      if (!dispatchId) return parent.onAssistant(message)
      sawSubagentTurn = true
      subagents?.onAssistant(dispatchId, message)
    },
    onToolResult(dispatchId, content) {
      if (!dispatchId) return parent.onToolResult(content)
      sawSubagentTurn = true
      subagents?.onToolResult(dispatchId, content)
    },
    flush() {
      parent.flush()
      subagents?.flush()
    },
    expectsWatcherCalls: () => opts.watcherOwnsSubagents && sawSubagentTurn,
  }
}
