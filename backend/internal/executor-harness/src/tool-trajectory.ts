import { redact } from './redact.js'

// The TRAJECTORY capture: what the agent DID, one entry per tool call, in the order it made them.
//
// The harness has always buffered a compact span per tool call (name + timing + ok) for the run's
// trace. That is enough to draw a tree and not enough to answer the question anyone actually asks
// of a finished run — WHICH command, against WHAT, and what came back. The evidence standard for a
// merged PR is "how, not just the diff", and a span saying `bash` ran for 300ms is not evidence of
// anything. So each entry now carries the call's arguments and result, captured here because this
// is the only process that ever sees them: an agent CLI's tool loop is internal to the CLI, and
// the container is gone the moment the job settles.
//
// Two properties keep that affordable and safe:
//
//  - **Bounded at capture.** Each body is capped (a build log is routinely megabytes) and the entry
//    STATES what the cap dropped, so a reader can tell a short command from the head of a long one.
//    The caps are what keep the drain buffer and the poll response small.
//  - **Scrubbed at capture.** A tool's arguments and output routinely echo an env var, a clone URL
//    or the leased subscription token, and these travel to a store and to external trace sinks.
//
// The RETENTION decision is the backend's, not this module's: entries carry `bodies: 'stored'` and
// the backend's double gate (`LLM_RECORD_PROMPTS` + the workspace's `storeAgentContext`) decides
// whether to keep them, exactly as it already does for the prompt bodies the call-metric
// reconstruction assembles here. Deciding it twice would mean the container had to be told the
// workspace's settings, and an image one release behind its backend would then be deciding it with
// stale ones.

/** Cap on a captured argument blob. Generous for a command line, far below a file body. */
export const MAX_TOOL_ARGS_CHARS = 2 * 1024
/** Cap on a captured result. Larger than the args cap: a result is where the bytes actually are. */
export const MAX_TOOL_RESULT_CHARS = 4 * 1024

/** A captured body plus what the cap dropped from it. */
export interface CapturedToolBody {
  text: string
  dropped: number
}

const EMPTY: CapturedToolBody = { text: '', dropped: 0 }

/**
 * Serialise, scrub and cap one tool body.
 *
 * A non-string value is JSON-serialised, and a value that cannot be (a cycle, a `BigInt`, a
 * throwing getter) is NAMED as unserialisable rather than dropped to `''`: an empty body means
 * "the call carried none", and a capture failure is a different fact.
 */
export function captureToolBody(
  value: unknown,
  max: number,
  secrets: readonly string[],
): CapturedToolBody {
  if (value === undefined || value === null) return EMPTY
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value) ?? ''
    } catch {
      return { text: '[unserialisable]', dropped: 0 }
    }
  }
  if (text === '') return EMPTY
  const scrubbed = redact(text, secrets)
  if (scrubbed.length <= max) return { text: scrubbed, dropped: 0 }
  return { text: scrubbed.slice(0, max), dropped: scrubbed.length - max }
}

/** One tool call the tracker is holding open, between its start and its result. */
interface PendingCall {
  tool: string
  startedAt: number
  args: CapturedToolBody
}

/** What {@link ToolCallTracker} emits per completed call — the fields a `ToolSpan` needs. */
export interface TrackedToolCall {
  tool: string
  seq: number
  startedAt: number
  endedAt: number
  ok: boolean
  args: string
  result: string
  argsDropped: number
  resultDropped: number
}

/**
 * Pairs each tool call's START with its RESULT and numbers the pairs, so the two agent CLIs feed
 * one trajectory shape from two very different streams (Pi's flat `tool_execution_*` events, the
 * claude-code stream's `tool_use` / `tool_result` content blocks).
 *
 * Correlation is BY ID where the stream supplies one, and by tool name otherwise, because that is
 * the difference between the two producers: claude-code's blocks always carry a `tool_use_id`, and
 * a parallel batch of calls is routine there, while Pi's stream is sequential. A result the tracker
 * cannot pair with a start is still EMITTED (with no args and the previous call's end as its
 * start): losing a step of the trajectory to a schema tweak would be worse than an entry that says
 * less than its neighbours, and the `seq` it takes keeps every later entry's ordinal honest.
 */
export class ToolCallTracker {
  private seq = 0
  private readonly byId = new Map<string, PendingCall>()
  private readonly byTool = new Map<string, PendingCall[]>()
  /**
   * Start boundary for a call whose own start was never seen: the previous call's end, or the run
   * start. Approximate but contiguous, which is the property the trace tree needs.
   */
  private boundary: number

  constructor(
    private readonly secrets: readonly string[] = [],
    now: number = Date.now(),
  ) {
    this.boundary = now
  }

  /** Record that a call began, with the arguments the agent supplied. */
  started(id: string | undefined, tool: string, args: unknown, at: number = Date.now()): void {
    const pending: PendingCall = {
      tool,
      startedAt: at,
      args: captureToolBody(args, MAX_TOOL_ARGS_CHARS, this.secrets),
    }
    if (id) {
      this.byId.set(id, pending)
      return
    }
    const queue = this.byTool.get(tool) ?? []
    queue.push(pending)
    this.byTool.set(tool, queue)
  }

  /** Record that a call finished, and return the completed entry. */
  finished(
    id: string | undefined,
    tool: string,
    result: unknown,
    isError: boolean,
    at: number = Date.now(),
  ): TrackedToolCall {
    const pending = this.take(id, tool)
    const captured = captureToolBody(result, MAX_TOOL_RESULT_CHARS, this.secrets)
    const call: TrackedToolCall = {
      tool: pending?.tool ?? tool,
      seq: this.seq++,
      startedAt: pending?.startedAt ?? this.boundary,
      endedAt: at,
      ok: !isError,
      args: pending?.args.text ?? '',
      argsDropped: pending?.args.dropped ?? 0,
      result: captured.text,
      resultDropped: captured.dropped,
    }
    this.boundary = at
    return call
  }

  private take(id: string | undefined, tool: string): PendingCall | undefined {
    if (id) {
      const byId = this.byId.get(id)
      if (byId) {
        this.byId.delete(id)
        return byId
      }
    }
    const queue = this.byTool.get(tool)
    // FIFO, so a sequential stream pairs each result with the call that opened first. A stream
    // that interleaves un-idded calls of one tool would mis-pair here; none of the two producers
    // does, and the alternative (refusing to pair at all) loses the args on every ordinary run.
    const pending = queue?.shift()
    if (queue && queue.length === 0) this.byTool.delete(tool)
    return pending
  }
}

/** Read a tool-call id off a stream event, whatever the producer calls it. */
export function readToolCallId(event: Record<string, unknown>): string | undefined {
  for (const key of ['toolCallId', 'tool_call_id', 'callId', 'id']) {
    const value = event[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** A tool call BEGINNING, read off a Pi `--mode json` event, or undefined if it isn't one. */
export function toolCallStart(
  event: Record<string, unknown>,
): { id?: string; name: string; args: unknown } | undefined {
  if (event.type !== 'tool_execution_start' && event.type !== 'tool_call') return undefined
  const name = typeof event.toolName === 'string' ? event.toolName : ''
  if (!name) return undefined
  // Read every spelling the stream might use rather than pinning one: Pi's event schema has been
  // renamed under us before (see `todoResultDetails`, which reads three shapes of one result), and
  // a rename here costs the ARGUMENTS of every call, silently.
  const args = event.args ?? event.arguments ?? event.input ?? event.parameters
  const id = readToolCallId(event)
  return { name, args, ...(id ? { id } : {}) }
}

/** The RESULT payload of a Pi `tool_execution_end` event, unwrapped from its envelope. */
export function toolCallResult(event: Record<string, unknown>): unknown {
  const result = event.result
  if (result && typeof result === 'object') {
    const inner = result as Record<string, unknown>
    // `details` is the structured payload Pi's own extensions return (the todo tool's shape), and
    // `content`/`output` the free-text ones. Falling back to the whole envelope keeps a shape none
    // of these match readable rather than empty.
    return inner.details ?? inner.content ?? inner.output ?? result
  }
  return result ?? event.output ?? event.content
}

/**
 * Feed one claude-code `user` turn's content blocks to the tracker, emitting an entry per
 * `tool_result`.
 *
 * The CLI answers each `tool_use` with a `tool_result` carrying the same `tool_use_id`, so the
 * pairing is exact even when the model fired a batch of calls in parallel — which it routinely
 * does, and which is why the trajectory here is ordered by the ordinal the tracker stamps rather
 * than by the turn the results arrived on.
 */
export function recordClaudeToolResults(
  tracker: ToolCallTracker,
  content: readonly unknown[],
  emit: (call: TrackedToolCall) => void,
): void {
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type !== 'tool_result') continue
    const id = typeof record.tool_use_id === 'string' ? record.tool_use_id : undefined
    // The block carries no tool NAME (only the id the assistant turn named), so an unpaired
    // result falls back to a stated placeholder rather than an empty string that would render
    // as a nameless step.
    emit(tracker.finished(id, 'unknown', record.content, record.is_error === true))
  }
}
