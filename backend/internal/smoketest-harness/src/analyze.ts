import {
  parseTodoProgress,
  summarizePiRun,
  terminalRunError,
} from '@cat-factory/executor-harness/embed'
import type { CaseAnalysis, CaseMetrics, Finding, FindingSeverity, PiEvent, Verdict } from './types'

// Pure analysis of a captured Pi run. Given the event stream (plus the run error,
// timing and the produced diff) it returns a list of findings + a coarse verdict.
// It REUSES the executor harness's own run interpreters — `summarizePiRun` (the
// canonical no-op / assistant-output signal), `terminalRunError` (the model went
// unusable and Pi exhausted retries) and `parseTodoProgress` (subtask state) —
// so the smoketest reads a run exactly the way the real harness does, then layers
// loop / dead-end heuristics on top. No grading: every finding is a structural
// observation, not a quality judgement.

/** Tool names that mutate files (mirrors the harness guard's `FILE_EDIT_TOOLS`). */
const FILE_EDIT_TOOLS = new Set([
  'edit',
  'write',
  'apply_patch',
  'patch',
  'str_replace',
  'multiedit',
  'create',
])

/** Read-only web tools (mirrors the harness guard's `WEB_TOOLS`). */
const WEB_TOOLS = new Set(['web_search', 'web_fetch'])

// Heuristic thresholds. Set deliberately BELOW the live guard's kill thresholds
// (e.g. the guard kills at 12 consecutive errors / 25 web calls) so a run that
// stalled but wasn't killed — or one taken with the guard relaxed — is still
// flagged for a human, instead of only the runs the guard already aborted.
const THRESHOLDS = {
  /** Identical (tool + args) call repeated at least this many times ⇒ a loop. */
  identicalCallRepeat: 4,
  /** This many same-named calls back-to-back ⇒ likely spinning on one tool. */
  sameToolStreak: 8,
  /** Consecutive failing tool calls ⇒ thrashing on a failing operation. */
  consecutiveErrors: 5,
  /** Fraction of tool calls that errored (with enough calls to be meaningful). */
  errorRate: 0.4,
  errorRateMinCalls: 5,
  /** Consecutive web search/fetch calls with nothing else between ⇒ research loop. */
  consecutiveWebCalls: 8,
  /** Many tool calls but a near-empty diff ⇒ lots of motion, no output. */
  lowYieldMinCalls: 25,
  lowYieldMaxDiffBytes: 200,
} as const

export interface AnalyzeInput {
  events: PiEvent[]
  /** The `runPi` rejection message, if the run failed/was killed. */
  error?: string
  durationMs: number
  /** Bytes of staged git diff the run produced. */
  diffBytes: number
  filesChanged: number
  /** Whether the task was expected to edit files (all coding fixtures: true). */
  expectsEdits?: boolean
}

function severityRank(s: FindingSeverity): number {
  return s === 'error' ? 2 : s === 'warn' ? 1 : 0
}

/** Roll the findings up into the coarse verdict (worst severity wins). */
function verdictFor(findings: Finding[]): Verdict {
  const worst = findings.reduce((max, f) => Math.max(max, severityRank(f.severity)), 0)
  return worst === 2 ? 'broken' : worst === 1 ? 'degraded' : 'healthy'
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * A truncated signature for a tool call so identical calls collide. Identical
 * args objects serialise identically (insertion order is stable), which is all
 * the loop check needs; the truncation keeps a giant file-write payload from
 * bloating the signature.
 */
function callSignature(name: string, args: unknown): string {
  let argStr = ''
  if (args !== undefined) {
    try {
      argStr = JSON.stringify(args) ?? ''
    } catch {
      argStr = ''
    }
  }
  return `${name}(${argStr.slice(0, 200)})`
}

/** Pull a tool call's args off an event/part under any of the common field names. */
function readArgs(source: Record<string, unknown>): unknown {
  for (const key of ['args', 'arguments', 'input', 'params', 'parameters']) {
    if (key in source) return source[key]
  }
  return undefined
}

interface ToolCall {
  name: string
  signature: string
}

/**
 * The ordered list of tool calls the agent issued, with a best-effort argument
 * signature. Prefers `tool_execution_start` (carries the args); falls back to the
 * assistant `toolCall` message parts, then to `tool_execution_end` names only — so
 * the call sequence is recovered even when one event shape is absent.
 */
function toolCallSequence(events: PiEvent[]): ToolCall[] {
  const starts: ToolCall[] = []
  for (const e of events) {
    if (e.type === 'tool_execution_start' && typeof e.toolName === 'string') {
      starts.push({ name: e.toolName, signature: callSignature(e.toolName, readArgs(e)) })
    }
  }
  if (starts.length) return starts

  const fromMessages: ToolCall[] = []
  for (const e of events) {
    if (e.type !== 'message_end' || !isObject(e.message)) continue
    const content = (e.message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!isObject(part) || part.type !== 'toolCall') continue
      const name =
        (typeof part.toolName === 'string' && part.toolName) ||
        (typeof part.name === 'string' && part.name) ||
        ''
      if (name) fromMessages.push({ name, signature: callSignature(name, readArgs(part)) })
    }
  }
  if (fromMessages.length) return fromMessages

  return endEvents(events).map((e) => ({
    name: String(e.toolName ?? ''),
    signature: callSignature(String(e.toolName ?? ''), undefined),
  }))
}

/** `tool_execution_end` events — the canonical per-call completion signal. */
function endEvents(events: PiEvent[]): PiEvent[] {
  return events.filter((e) => e.type === 'tool_execution_end')
}

/** Longest run of consecutive items satisfying `pred` (resets to 0 on a miss). */
function longestRun<T>(items: T[], pred: (item: T) => boolean): number {
  let max = 0
  let cur = 0
  for (const item of items) {
    cur = pred(item) ? cur + 1 : 0
    if (cur > max) max = cur
  }
  return max
}

/** Longest run of consecutive items sharing the same `key`. */
function longestSameKeyRun<T>(items: T[], key: (item: T) => string): number {
  let max = 0
  let cur = 0
  let prevKey: string | undefined
  for (const item of items) {
    const k = key(item)
    cur = k === prevKey ? cur + 1 : 1
    if (cur > max) max = cur
    prevKey = k
  }
  return max
}

function tokenUsage(events: PiEvent[]): { inputTokens: number; outputTokens: number } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    const usage = isObject(e.usage) ? e.usage : isObject(e.totalUsage) ? e.totalUsage : undefined
    if (!usage) continue
    const input = Number(usage.inputTokens ?? usage.promptTokens ?? usage.input)
    const output = Number(usage.outputTokens ?? usage.completionTokens ?? usage.output)
    if (Number.isFinite(input) || Number.isFinite(output)) {
      return {
        inputTokens: Number.isFinite(input) ? input : 0,
        outputTokens: Number.isFinite(output) ? output : 0,
      }
    }
  }
  return undefined
}

/** Compute the quantitative metrics from the captured events + the diff. */
export function computeMetrics(input: AnalyzeInput): CaseMetrics {
  const { events } = input
  const stdout = events.map((e) => JSON.stringify(e)).join('\n')
  const { stats } = summarizePiRun(stdout)

  const ends = endEvents(events)
  const histogram: Record<string, number> = {}
  let toolErrors = 0
  let edits = 0
  for (const e of ends) {
    const name = String(e.toolName ?? 'unknown')
    histogram[name] = (histogram[name] ?? 0) + 1
    if (e.isError === true) toolErrors++
    if (FILE_EDIT_TOOLS.has(name.toLowerCase())) edits++
  }

  let todo: CaseMetrics['todo']
  for (const e of events) {
    const progress = parseTodoProgress(e)
    if (progress) {
      todo = {
        completed: progress.completed,
        inProgress: progress.inProgress,
        total: progress.total,
      }
    }
  }

  return {
    toolCalls: ends.length || stats.toolCalls,
    toolErrors,
    edits,
    assistantChars: stats.assistantChars,
    events: events.length,
    durationMs: input.durationMs,
    diffBytes: input.diffBytes,
    filesChanged: input.filesChanged,
    todo,
    usage: tokenUsage(events),
    toolHistogram: histogram,
  }
}

/**
 * Analyse one captured run into findings + a verdict. Pure over its input so it
 * is unit-testable against a fixed event sequence.
 */
export function analyzeCase(input: AnalyzeInput): CaseAnalysis {
  const { events, error } = input
  const expectsEdits = input.expectsEdits ?? true
  const metrics = computeMetrics(input)
  const stdout = events.map((e) => JSON.stringify(e)).join('\n')
  const { summary, stats } = summarizePiRun(stdout)
  const findings: Finding[] = []
  const add = (f: Finding) => findings.push(f)

  const err = error?.trim()
  const isSpawnFailure = !!err && /spawn\s+pi|ENOENT|command not found/i.test(err)
  const isGuardAbort = !!err && err.includes('no progress:')
  const isWatchdogAbort = !!err && !isGuardAbort && /\baborted\b/i.test(err)
  const terminalErr = terminalRunError(stdout)

  // --- Breakage: the model could not be used / the run hard-failed. ---
  if (isSpawnFailure) {
    add({
      code: 'pi-not-runnable',
      category: 'breakage',
      severity: 'error',
      message: 'Pi could not be started — is the `pi` CLI on PATH?',
      detail: err,
    })
  } else if (events.length === 0) {
    add({
      code: 'no-events',
      category: 'breakage',
      severity: 'error',
      message: 'Pi produced no parseable events — the run never got off the ground.',
      detail: err,
    })
  }

  if (terminalErr) {
    add({
      code: 'terminal-model-error',
      category: 'breakage',
      severity: 'error',
      message: 'The model went unusable mid-run and Pi exhausted its retries.',
      detail: terminalErr,
    })
  }

  // A run that reached the model but produced nothing — no tool calls, no text.
  if (!isSpawnFailure && events.length > 0 && stats.toolCalls === 0 && stats.assistantChars === 0) {
    add({
      code: 'no-op-run',
      category: 'breakage',
      severity: 'error',
      message: 'The model produced no output at all — zero tool calls and zero assistant text.',
      detail: err,
    })
  }

  // --- Dead-ends: the agent stopped making progress. ---
  if (isGuardAbort) {
    const { code, category, message } = classifyGuardAbort(err!)
    add({ code, category, severity: 'error', message, detail: err })
  } else if (isWatchdogAbort) {
    add({
      code: 'watchdog-abort',
      category: 'dead-end',
      severity: 'error',
      message: 'The run hit the inactivity / max-duration watchdog and was killed.',
      detail: err,
    })
  } else if (err && !terminalErr && !isSpawnFailure && events.length > 0) {
    // Any other non-zero exit / unexpected rejection (an empty stream is already
    // covered by `no-events`, so don't double-report it here).
    add({
      code: 'run-error',
      category: 'breakage',
      severity: 'error',
      message: 'The Pi run failed.',
      detail: err,
    })
  }

  const ranAtAll = events.length > 0 && (stats.toolCalls > 0 || stats.assistantChars > 0)

  // Expected to change files but didn't — a soft dead-end (it talked/explored but
  // never implemented). Only flag when the run actually executed and wasn't already
  // killed for no progress (which implies the same thing more strongly).
  if (expectsEdits && input.diffBytes === 0 && ranAtAll && !isGuardAbort && !isWatchdogAbort) {
    add({
      code: 'no-changes',
      category: 'dead-end',
      severity: 'warn',
      message: 'The agent ran but produced no file changes — it never landed an implementation.',
      detail: `${metrics.toolCalls} tool call(s), ${metrics.edits} edit-tool call(s).`,
    })
  }

  // --- Loops: repeating without advancing. ---
  const calls = toolCallSequence(events)
  const ends = endEvents(events)

  if (!isGuardAbort || !err!.includes('consecutive failing')) {
    const errStreak = longestRun(ends, (e) => e.isError === true)
    if (errStreak >= THRESHOLDS.consecutiveErrors) {
      add({
        code: 'consecutive-tool-errors',
        category: 'loop',
        severity: 'warn',
        message: `Hit ${errStreak} failing tool calls in a row — thrashing on a failing operation.`,
      })
    }
  }

  if (metrics.toolCalls >= THRESHOLDS.errorRateMinCalls) {
    const rate = metrics.toolErrors / metrics.toolCalls
    if (rate >= THRESHOLDS.errorRate) {
      add({
        code: 'high-error-rate',
        category: 'loop',
        severity: 'warn',
        message: `${Math.round(rate * 100)}% of tool calls errored (${metrics.toolErrors}/${metrics.toolCalls}).`,
      })
    }
  }

  const repeat = mostRepeatedCall(calls)
  if (repeat && repeat.count >= THRESHOLDS.identicalCallRepeat) {
    add({
      code: 'repeated-tool-call',
      category: 'loop',
      severity: 'warn',
      message: `The same tool call was issued ${repeat.count} times — likely an unproductive loop.`,
      detail: repeat.signature,
    })
  } else {
    const streak = longestSameKeyRun(calls, (c) => c.name)
    if (streak >= THRESHOLDS.sameToolStreak) {
      add({
        code: 'same-tool-streak',
        category: 'loop',
        severity: 'warn',
        message: `Called the same tool ${streak} times back-to-back — possibly spinning.`,
      })
    }
  }

  if (!isGuardAbort || !err!.includes('web search/fetch')) {
    const webStreak = longestRun(calls, (c) => WEB_TOOLS.has(c.name.toLowerCase()))
    if (webStreak >= THRESHOLDS.consecutiveWebCalls) {
      add({
        code: 'web-search-loop',
        category: 'loop',
        severity: 'warn',
        message: `Made ${webStreak} web search/fetch calls in a row — researching instead of building.`,
      })
    }
  }

  if (
    metrics.toolCalls >= THRESHOLDS.lowYieldMinCalls &&
    input.diffBytes > 0 &&
    input.diffBytes < THRESHOLDS.lowYieldMaxDiffBytes
  ) {
    add({
      code: 'low-yield',
      category: 'loop',
      severity: 'warn',
      message: `${metrics.toolCalls} tool calls produced only ${input.diffBytes} bytes of diff — lots of motion, little output.`,
    })
  }

  // Left subtasks unfinished while still producing changes — worth a look but not
  // a failure on its own.
  if (
    metrics.todo &&
    metrics.todo.total > 0 &&
    metrics.todo.completed < metrics.todo.total &&
    input.diffBytes > 0 &&
    ranAtAll
  ) {
    add({
      code: 'incomplete-todos',
      category: 'dead-end',
      severity: 'warn',
      message: `Finished with ${metrics.todo.completed}/${metrics.todo.total} subtasks done — left work on the table.`,
    })
  }

  return { verdict: verdictFor(findings), findings, metrics, summary: summary || undefined }
}

/** Sub-classify a guard-abort error message into a specific finding. */
function classifyGuardAbort(err: string): {
  code: string
  category: Finding['category']
  message: string
} {
  if (err.includes('not one file edit') || err.includes('without implementing')) {
    return {
      code: 'guard-no-edits',
      category: 'dead-end',
      message:
        'Killed by the no-progress guard: many tool calls without ever editing a file (probing, not building).',
    }
  }
  if (err.includes('consecutive failing')) {
    return {
      code: 'guard-error-loop',
      category: 'loop',
      message:
        'Killed by the no-progress guard: stuck retrying a failing operation (consecutive errors).',
    }
  }
  if (err.includes('web search/fetch')) {
    return {
      code: 'guard-web-loop',
      category: 'loop',
      message: 'Killed by the no-progress guard: stuck in a web search/fetch loop.',
    }
  }
  return {
    code: 'guard-abort',
    category: 'dead-end',
    message: 'Killed by the no-progress guard: the run stopped making progress.',
  }
}

/** The most-repeated identical tool call (with args) and its count. */
function mostRepeatedCall(calls: ToolCall[]): { signature: string; count: number } | undefined {
  const counts = new Map<string, number>()
  for (const c of calls) {
    // Only count signatures that actually carry args — a bare `name()` repeated is
    // already covered (more conservatively) by the same-tool-streak check.
    if (c.signature.endsWith('()')) continue
    counts.set(c.signature, (counts.get(c.signature) ?? 0) + 1)
  }
  let best: { signature: string; count: number } | undefined
  for (const [signature, count] of counts) {
    if (!best || count > best.count) best = { signature, count }
  }
  return best
}
