import { BoundedTail } from './jsonl-stream.js'

// Reducing a Pi `--mode json` event stream to what the run PRODUCED: the assistant's answer, what
// it actually did, its output-quality signals, and whether it ended in a hard error.
//
// WHY THIS IS ITS OWN MODULE — every one of these answers used to be computed by scanning a
// retained array of every record the run emitted, and `runPi` held that array for the whole run
// (stuck-run audit F6). Bounding the JSONL FRAMING while retaining an unbounded number of parsed
// records only moves the heap-exhaustion mode: a parsed object is typically larger than the raw
// text it replaced, and a container that OOMs is another way for a job to stop answering polls
// with no watchdog having fired.
//
// So the reduction FOLDS instead. {@link PiRunReducer} observes each record as it streams and
// retains only what the close-of-run answers actually need: the terminal record, the one
// transcript they read, running counters, and a bounded tail of streamed assistant text. Its
// memory is O(largest single record), not O(records).
//
// The array-shaped entry points below (used by offline tooling over a captured stdout) are
// DEFINED in terms of the same reducer rather than keeping their own scans, so the live path and
// the offline one cannot drift into disagreeing about what a run produced.

/**
 * Per-completion output-token ceiling Pi requests (its model-entry `maxTokens`).
 * Generous on purpose: a reasoning model (e.g. GLM-5.2) spends tokens on its
 * `<think>` trace before the answer + tool calls, so a tight cap truncates it
 * mid-reasoning and the agent never commits edits. It is a ceiling, not a target
 * — unused output tokens are not billed and Workers AI clamps the request to the
 * model's real max — so erring high is safe. Raised to 32k after a spec-writer run
 * truncated an intermediate tool call at the old 16k cap; the document itself
 * stopped well under it, so this is headroom for larger specs/diffs, with
 * {@link runDiagnostics} flagging the rare case where even 32k is not enough.
 */
export const PI_MAX_OUTPUT_TOKENS = 32_768

/**
 * How much streamed assistant text the fallback summary holds when a run emitted no terminal
 * transcript. Far above any real answer, because this is a bound on a runaway producer rather
 * than a size policy — and what it drops is REPORTED (see {@link PiRunReducer.reduce}), since a
 * tail read as a whole answer would look like a model that stopped mid-sentence.
 */
const FALLBACK_SUMMARY_CHARS = 256 * 1024

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * What the agent actually did this run, independent of any file changes. Used to
 * tell a genuine no-op (the agent never reached the model / never acted) apart
 * from a real run, so a bootstrap that produced nothing is failed rather than
 * pushed as an empty repo. `toolCalls === 0 && assistantChars === 0` is the
 * signature of a run where Pi never made a successful model call.
 */
export interface PiRunStats {
  /** Tool calls the assistant emitted across the transcript (0 ⇒ it never acted). */
  toolCalls: number
  /** Total characters of assistant text (0 ⇒ the model produced nothing). */
  assistantChars: number
}

/**
 * Output-quality signals lifted from the agent's transcript, so the harness can fail
 * LOUDLY on a malformed run instead of silently handing a half-baked artifact to the
 * structured-output repair (which would manufacture a doc from garbage — the trap
 * behind the spec-writer ⇄ companion rework loop). Two distinct invalid states, both
 * seen in production from `kimi-k2.7-code`:
 *  - a completion that hit the output ceiling (its answer/tool call was cut off), and
 *  - a FINAL turn that carried no text at all (an empty `content: []` despite spending
 *    output tokens), so there is no answer to parse.
 */
export interface RunDiagnostics {
  /** Some completion ended at the output-token ceiling — its content was cut off. */
  truncated: boolean
  /** The agent's FINAL completion hit the ceiling: its ANSWER (not a mid-run step) was cut off. */
  finalTruncated: boolean
  /** The agent's final turn carried no text content (e.g. an empty `content: []`). */
  finalAnswerEmpty: boolean
}

/** What a Pi run's event stream reduces to (the run's product, before any process-level detail). */
export interface PiRunReduction {
  summary: string
  stats: PiRunStats
  diagnostics: RunDiagnostics
}

/**
 * Folds a Pi event stream into {@link PiRunReduction} plus the run's terminal-failure signal.
 *
 * Feed every parsed record to {@link observe} in stream order, then read the answers at close.
 * What it keeps, and why that is all of it:
 *  - the LAST `agent_end` / `auto_retry_end` record, which is exactly what a scan-from-the-end
 *    for the terminal signal would have stopped on;
 *  - the LAST `agent_end` transcript, the canonical source for the summary, the stats and the
 *    diagnostics alike (all three scanned back to the same record);
 *  - running counters and a bounded text tail, which are the FALLBACKS those three use when a
 *    run emitted no terminal transcript at all.
 */
export class PiRunReducer {
  /** The last terminal record seen (`agent_end` or `auto_retry_end`), whichever came last. */
  private terminal: Record<string, unknown> | undefined
  /** Messages of the last `agent_end` that carried a transcript. */
  private transcript: unknown[] | undefined
  private streamedToolCalls = 0
  private streamedToolResults = 0
  private streamedAssistantChars = 0
  private readonly streamedText = new BoundedTail(FALLBACK_SUMMARY_CHARS)

  /** Fold one parsed record. */
  observe(event: Record<string, unknown>): void {
    const type = event.type
    if (type === 'agent_end' || type === 'auto_retry_end') {
      this.terminal = event
      if (type === 'agent_end' && Array.isArray(event.messages)) {
        this.transcript = event.messages as unknown[]
      }
      return
    }
    if (type === 'tool_execution_end') {
      this.streamedToolCalls++
      return
    }
    if (type === 'message_end' && isObject(event.message)) {
      const message = event.message
      if (message.role === 'assistant') {
        const text = messageText(message)
        this.streamedAssistantChars += text.length
        if (text) this.streamedText.push(this.streamedText.totalChars ? `\n${text}` : text)
      } else if (message.role === 'toolResult') {
        this.streamedToolResults++
      }
    }
  }

  /**
   * Whether the run emitted a terminal record at all. False means {@link terminalError} answered
   * from nothing rather than from a clean ending, which a caller deciding whether the run
   * SUCCEEDED has to tell apart (see `runPi`'s exit-0 path).
   */
  get sawTerminalRecord(): boolean {
    return this.terminal !== undefined
  }

  /**
   * The terminal-failure message when the run ended in a hard error (the model was unreachable /
   * refused, and Pi exhausted its auto-retries), else undefined. Only the FINAL outcome counts: a
   * mid-run hiccup the agent recovered from leaves a clean terminal `agent_end`.
   */
  terminalError(): string | undefined {
    const e = this.terminal
    if (!e) return undefined
    if (e.type === 'auto_retry_end') {
      if (e.success === false) {
        return typeof e.finalError === 'string'
          ? e.finalError
          : 'the agent failed after exhausting its retries'
      }
      return undefined
    }
    return e.stopReason === 'error' && typeof e.errorMessage === 'string'
      ? e.errorMessage
      : undefined
  }

  /**
   * The run's product. `stdoutTail` backs the last-resort summary for a run whose output matched
   * nothing structured, and a TAIL is all that fallback ever wanted: it slices the final 2 KB.
   */
  reduce(stdoutTail: string, cap: number = PI_MAX_OUTPUT_TOKENS): PiRunReduction {
    return {
      summary: this.summary(stdoutTail),
      stats: this.stats(),
      diagnostics: this.diagnostics(cap),
    }
  }

  /**
   * Preferred: the last assistant message of the terminal transcript. Falls back to the streamed
   * assistant text, then to a raw tail, so a schema tweak never loses output.
   */
  private summary(stdoutTail: string): string {
    if (this.transcript) {
      const text = lastAssistantText(this.transcript)
      if (text) return text
    }
    const streamed = this.streamedText.toString().trim()
    if (streamed) {
      const dropped = this.streamedText.droppedChars
      // Say so when this is a tail rather than the whole answer: a reader who took it for a
      // prefix would conclude the model stopped where the text begins.
      return dropped > 0
        ? `[earlier assistant output omitted: ${dropped} characters]\n${streamed}`
        : streamed
    }
    return stdoutTail.trim().slice(-2000)
  }

  /**
   * Count what the agent actually did. Prefers the terminal transcript (assistant `toolCall`
   * parts + text); falls back to the streamed `tool_execution_end` / `message_end` counters, so a
   * no-op is never mistaken for a real run because of a schema tweak.
   */
  private stats(): PiRunStats {
    if (this.transcript) return statsFromMessages(this.transcript)
    return {
      // The same call can surface as both a `tool_execution_end` and a toolResult `message_end`;
      // prefer the former and only fall back to toolResult counts.
      toolCalls: this.streamedToolCalls || this.streamedToolResults,
      assistantChars: this.streamedAssistantChars,
    }
  }

  /**
   * Output-quality signals over the terminal transcript: whether any completion hit the output
   * ceiling (its content was cut off), whether the FINAL completion did, and whether that final
   * turn carried no text at all. Defaults to all-false with no terminal transcript (a no-op run
   * is already caught by `agentNeverActed`).
   *
   * `cap` is the per-completion ceiling Pi requested ({@link PI_MAX_OUTPUT_TOKENS}); truncation is
   * detected by an assistant message whose `usage.output` reached it, which is reliable even when
   * the model reports a non-`length` stop reason (Workers AI labelled a cut-off tool call
   * `tool_calls`, not `length`).
   */
  private diagnostics(cap: number): RunDiagnostics {
    if (!this.transcript) {
      return { truncated: false, finalTruncated: false, finalAnswerEmpty: false }
    }
    const assistants = this.transcript.filter(
      (m): m is Record<string, unknown> => isObject(m) && m.role === 'assistant',
    )
    const last = assistants.at(-1)
    return {
      truncated: assistants.some((m) => assistantOutputTokens(m) >= cap),
      finalTruncated: last ? assistantOutputTokens(last) >= cap : false,
      finalAnswerEmpty: last ? messageText(last) === '' : false,
    }
  }
}

/** Fold an already-parsed event array through a fresh {@link PiRunReducer}. */
function reducerOver(events: Record<string, unknown>[]): PiRunReducer {
  const reducer = new PiRunReducer()
  for (const event of events) reducer.observe(event)
  return reducer
}

/** Parse Pi's LF-framed JSONL stdout into its event records, skipping noise. */
export function parsePiEvents(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      events.push(JSON.parse(trimmed) as Record<string, unknown>)
    } catch {
      // Skip a corrupted/truncated record; the surrounding stream is still usable.
    }
  }
  return events
}

/** {@link PiRunReducer.terminalError} over Pi's raw `--mode json` stdout. */
export function terminalRunError(stdout: string): string | undefined {
  return terminalErrorFromEvents(parsePiEvents(stdout))
}

/** {@link PiRunReducer.terminalError} over records already parsed from the stream. */
export function terminalErrorFromEvents(events: Record<string, unknown>[]): string | undefined {
  return reducerOver(events).terminalError()
}

/** {@link PiRunReducer.reduce} over Pi's raw `--mode json` stdout. */
export function summarizePiRun(stdout: string): PiRunReduction {
  return summarizeFromEvents(parsePiEvents(stdout), stdout)
}

/** {@link PiRunReducer.reduce} over records already parsed from the stream. */
export function summarizeFromEvents(
  events: Record<string, unknown>[],
  stdoutTail: string,
): PiRunReduction {
  return reducerOver(events).reduce(stdoutTail)
}

/** {@link RunDiagnostics} over records already parsed from the stream. */
export function diagnosticsFromEvents(
  events: Record<string, unknown>[],
  cap: number = PI_MAX_OUTPUT_TOKENS,
): RunDiagnostics {
  return reducerOver(events).reduce('', cap).diagnostics
}

/** {@link RunDiagnostics} over Pi's raw `--mode json` stdout. */
export function runDiagnostics(stdout: string, cap: number = PI_MAX_OUTPUT_TOKENS): RunDiagnostics {
  return diagnosticsFromEvents(parsePiEvents(stdout), cap)
}

/**
 * Extract the assistant's final summary from Pi's JSON-lines output. Pi emits a terminal
 * `agent_end` event whose `messages` is the full transcript, so the last assistant message there
 * is the canonical answer (see {@link PiRunReducer.reduce} for the fallbacks).
 */
export function parsePiOutput(stdout: string): string {
  return summarizePiRun(stdout).summary
}

/** `usage.output` (completion tokens) reported on a Pi assistant message, or 0. */
function assistantOutputTokens(message: Record<string, unknown>): number {
  const usage = message.usage
  if (!isObject(usage)) return 0
  const output = usage.output
  return typeof output === 'number' ? output : 0
}

/** {@link PiRunStats} from a transcript: assistant `toolCall` parts + text length. */
function statsFromMessages(messages: unknown[]): PiRunStats {
  let toolCalls = 0
  let assistantChars = 0
  for (const m of messages) {
    if (!isObject(m) || m.role !== 'assistant') continue
    const content = m.content
    if (typeof content === 'string') {
      assistantChars += content.trim().length
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!isObject(part)) continue
        if (part.type === 'toolCall') toolCalls++
        else if (typeof part.text === 'string') assistantChars += part.text.length
      }
    }
  }
  return { toolCalls, assistantChars }
}

/** The text of the last assistant message in a transcript, or '' if none. */
function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (isObject(m) && m.role === 'assistant') {
      const text = messageText(m)
      if (text) return text
    }
  }
  return ''
}

/** Join the text parts of a Pi message whose content is a string or parts array. */
export function messageText(message: unknown): string {
  if (!isObject(message)) return ''
  const content = message.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim()
  }
  return ''
}
