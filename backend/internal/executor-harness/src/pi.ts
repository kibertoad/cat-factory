import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redactSecrets } from './git.js'

// Drives the Pi coding-agent CLI. Pi is pointed at the Worker's OpenAI-compatible
// proxy via a custom provider in ~/.pi/agent/models.json, authenticated with the
// per-job session token (interpolated from $PI_PROXY_TOKEN) — so no provider key
// ever lives in the image or in Pi's config on disk.

/**
 * Per-completion output-token ceiling Pi requests (its model-entry `maxTokens`).
 * Generous on purpose: a reasoning model (e.g. GLM-5.2) spends tokens on its
 * `<think>` trace before the answer + tool calls, so a tight cap truncates it
 * mid-reasoning and the agent never commits edits. It is a ceiling, not a target
 * — unused output tokens are not billed — so erring high is safe.
 */
export const PI_MAX_OUTPUT_TOKENS = 16_384

/** Write the Pi provider config that routes all model calls through the proxy. */
export async function writePiModelsConfig(opts: {
  model: string
  proxyBaseUrl: string
  /** Output-token ceiling Pi may request per completion. Defaults to PI_MAX_OUTPUT_TOKENS. */
  maxTokens?: number
}): Promise<string> {
  const dir = join(homedir(), '.pi', 'agent')
  await mkdir(dir, { recursive: true })
  const config = {
    providers: {
      proxy: {
        baseUrl: opts.proxyBaseUrl,
        api: 'openai-completions',
        // Interpolated by Pi from the environment at run time.
        apiKey: '$PI_PROXY_TOKEN',
        // OpenAI-compatible upstreams behind the proxy don't all accept the
        // `developer` role or `reasoning_effort`; send a plain system message.
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        // `maxTokens` is Pi's per-completion output ceiling — set it generously so
        // a reasoning model isn't cut off mid-think (see PI_MAX_OUTPUT_TOKENS).
        models: [
          { id: opts.model, name: opts.model, maxTokens: opts.maxTokens ?? PI_MAX_OUTPUT_TOKENS },
        ],
      },
    },
  }
  const path = join(dir, 'models.json')
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8')
  return path
}

// Appended to every AGENTS.md so the model maintains the `todo` tool the image
// installs (rpiv-todo). Without a nudge a model may skip the tool, which would
// leave the run with no subtask progress to report; keeping the list current is
// what makes the board's "N/M done" move.
const TODO_GUIDANCE = `

## Progress tracking (required)

You have a \`todo\` tool. For any multi-step task, before you start coding, break
the work into concrete subtasks with \`todo\` (action "create"). As you work, mark
each one \`in_progress\` when you begin it and \`completed\` when it's done (action
"update"). Keep the list accurate — it is the only signal the system has for how
far along the run is.`

// Appended to every AGENTS.md so an agent orients off the persisted service
// blueprint before touching code, but stays shallow by default: read the
// high-level overview first, and only open a module's deep-dive when the task
// actually touches it. Harmless when no blueprint exists yet (e.g. a fresh
// bootstrap) — the files simply aren't there to read.
const BLUEPRINT_GUIDANCE = `

## Service blueprint (read first, stay shallow)

If a \`blueprints/\` folder exists, it is the map of this service. **Before you start,
read \`blueprints/overview.md\`** for the high-level structure (the service and its
modules). Do NOT read every module file. Only open \`blueprints/modules/<name>.md\`
for a module that is directly relevant to your task, when you need its summary and
exact code references. \`blueprints/version.json\` is a tiny manifest for quick
staleness checks. Treat the blueprint as orientation, not a task list.`

/** Write the composed system prompt as project context Pi reads automatically. */
export async function writeAgentsContext(cwd: string, systemPrompt: string): Promise<void> {
  await writeFile(
    join(cwd, 'AGENTS.md'),
    `${systemPrompt}${BLUEPRINT_GUIDANCE}${TODO_GUIDANCE}`,
    'utf8',
  )
}

/** One entry of the agent's todo list — its subject and current status. */
export interface TodoItem {
  /** The task's subject text, as the agent wrote it. */
  label: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Live subtask progress derived from Pi's `todo` tool — e.g. "3/8 done". */
export interface TodoProgress {
  /** Tasks marked completed. */
  completed: number
  /** Tasks currently being worked (rpiv-todo's `in_progress` status). */
  inProgress: number
  /** Total live tasks (tombstoned/deleted tasks excluded). */
  total: number
  /**
   * The individual live tasks (label + status), in list order — so the board can
   * render the actual task list, not just the count. Absent for the simpler
   * `todos[].done` fallback shape, which carries no per-task subject.
   */
  items?: TodoItem[]
}

function isObject(value: unknown): value is Record<string, unknown> {
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

/** Pi's assistant summary plus {@link PiRunStats} describing what it did. */
export interface PiRunOutcome {
  summary: string
  stats: PiRunStats
  /**
   * Tail of Pi's stderr (credential-scrubbed), captured even on a clean exit.
   * On a no-op run this is where the real cause shows up — e.g. an unreachable
   * proxy or a model the upstream rejected — so the failure is diagnosable
   * without shelling into the (ephemeral) container.
   */
  stderrTail?: string
}

/**
 * Pull the `todo` tool's result `details` out of a Pi `--mode json` event, or
 * undefined if the event isn't a successful `todo` tool result.
 *
 * The same tool result surfaces on the stream as two raw agent events, both of
 * which we read (whichever Pi emits/orders first wins; the counts are identical):
 *   - `message_end` with a `toolResult` message — `message.details`
 *   - `tool_execution_end` — `result.details`
 * A top-level `tool_result` shape is also accepted defensively. Pi has no
 * built-in todo tool, so this only ever matches the installed extension's calls.
 */
function todoResultDetails(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (event.type === 'message_end' && isObject(event.message)) {
    const m = event.message
    if (
      m.role === 'toolResult' &&
      m.toolName === 'todo' &&
      m.isError !== true &&
      isObject(m.details)
    ) {
      return m.details
    }
    return undefined
  }
  if (event.type === 'tool_execution_end' && event.toolName === 'todo' && event.isError !== true) {
    return isObject(event.result) && isObject(event.result.details)
      ? event.result.details
      : undefined
  }
  if (event.type === 'tool_result' && event.toolName === 'todo' && event.isError !== true) {
    return isObject(event.details) ? event.details : undefined
  }
  return undefined
}

/**
 * Derive {@link TodoProgress} from a single Pi `--mode json` event, or undefined
 * if the event isn't a successful `todo` tool result we can read.
 *
 * Pi has no built-in todo tool; the image installs the `@juicesharp/rpiv-todo`
 * extension, whose every successful call returns `details.tasks[]` with a
 * per-task `status` (pending | in_progress | completed | deleted). We also accept
 * the simpler `details.todos[].done` shape of Pi's bundled example extension, so
 * swapping the extension never silently drops progress.
 */
/**
 * Best-effort subject for a todo task. rpiv-todo creates tasks with a `subject`
 * (see the `todo` `create` action); we also accept the common alternates so a
 * minor extension change never blanks the label. Falls back to "Untitled task".
 */
function taskLabel(task: unknown): string {
  if (task && typeof task === 'object') {
    const t = task as Record<string, unknown>
    for (const key of ['subject', 'title', 'content', 'text', 'name', 'task']) {
      const v = t[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return 'Untitled task'
}

export function parseTodoProgress(event: Record<string, unknown>): TodoProgress | undefined {
  const d = todoResultDetails(event)
  if (!d) return undefined

  if (Array.isArray(d.tasks)) {
    let total = 0
    let completed = 0
    let inProgress = 0
    const items: TodoItem[] = []
    for (const task of d.tasks) {
      const status = (task as { status?: unknown } | null)?.status
      if (status === 'deleted') continue
      total++
      if (status === 'completed') completed++
      else if (status === 'in_progress') inProgress++
      items.push({
        label: taskLabel(task),
        status:
          status === 'completed'
            ? 'completed'
            : status === 'in_progress'
              ? 'in_progress'
              : 'pending',
      })
    }
    return { completed, inProgress, total, items }
  }

  if (Array.isArray(d.todos)) {
    const completed = d.todos.filter((t) => (t as { done?: unknown } | null)?.done === true).length
    return { completed, inProgress: 0, total: d.todos.length }
  }

  return undefined
}

/** Tool-call signal read off a streamed Pi event, or undefined if not a tool call. */
function toolCallSignal(
  event: Record<string, unknown>,
): { name: string; isError: boolean } | undefined {
  // `tool_execution_end` is the canonical per-call stream event (statsFromEvents
  // counts the same one), so the guard reads it and nothing else — no double count.
  if (event.type !== 'tool_execution_end') return undefined
  const name = typeof event.toolName === 'string' ? event.toolName : ''
  return { name, isError: event.isError === true }
}

/** Tunable bounds for the {@link ProgressGuard}. */
export interface ProgressGuardLimits {
  /**
   * Abort once the agent has made this many tool calls without ever using a
   * file-editing tool (`edit`/`write`). The signature of a run that explores or —
   * as in the credential rabbit-hole that motivated this — probes the environment
   * endlessly without implementing anything. Disabled when `expectsEdits` is false
   * (e.g. the assess-only merger, which legitimately edits nothing).
   */
  maxToolCallsWithoutEdit: number
  /**
   * Abort after this many consecutive failing tool calls — the agent is stuck
   * retrying an operation that keeps failing rather than making progress.
   */
  maxConsecutiveErrors: number
}

export const DEFAULT_PROGRESS_GUARD_LIMITS: ProgressGuardLimits = {
  maxToolCallsWithoutEdit: 30,
  maxConsecutiveErrors: 12,
}

const FILE_EDIT_TOOLS = new Set(['edit', 'write'])

/** Read {@link ProgressGuardLimits} from the environment, falling back to the defaults. */
export function progressGuardLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProgressGuardLimits {
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  }
  return {
    maxToolCallsWithoutEdit: num(
      env.JOB_MAX_TOOLCALLS_WITHOUT_EDIT,
      DEFAULT_PROGRESS_GUARD_LIMITS.maxToolCallsWithoutEdit,
    ),
    maxConsecutiveErrors: num(
      env.JOB_MAX_CONSECUTIVE_TOOL_ERRORS,
      DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveErrors,
    ),
  }
}

/**
 * Live anti-rabbithole guard: fed each streamed Pi event, it returns a diagnostic
 * reason the moment a run has plainly stopped making progress, so the harness can
 * kill Pi early instead of letting it burn the whole budget (and then surface a
 * useful failure instead of a generic "no file changes"). Pure and incremental so
 * it can be unit-tested over a fixed event sequence.
 */
export class ProgressGuard {
  private toolCalls = 0
  private edits = 0
  private consecutiveErrors = 0

  constructor(
    private readonly limits: ProgressGuardLimits,
    /** When false (assess-only runs like the merger), the no-edit bound is skipped. */
    private readonly expectsEdits: boolean = true,
  ) {}

  /** Feed one parsed Pi event; returns a diagnostic reason when the run should abort, else null. */
  observe(event: Record<string, unknown>): string | null {
    const tool = toolCallSignal(event)
    if (!tool) return null
    this.toolCalls++
    this.consecutiveErrors = tool.isError ? this.consecutiveErrors + 1 : 0
    if (FILE_EDIT_TOOLS.has(tool.name)) this.edits++

    if (
      this.expectsEdits &&
      this.edits === 0 &&
      this.toolCalls >= this.limits.maxToolCallsWithoutEdit
    ) {
      return (
        `no progress: ${this.toolCalls} tool calls and not one file edit — the agent is exploring or ` +
        `probing the environment without implementing anything. Aborting before it burns the whole run.`
      )
    }
    if (this.consecutiveErrors >= this.limits.maxConsecutiveErrors) {
      return (
        `no progress: ${this.consecutiveErrors} consecutive failing tool calls — the agent is stuck ` +
        `retrying a failing operation rather than making progress. Aborting.`
      )
    }
    return null
  }
}

/**
 * Run Pi non-interactively against `cwd` and return its assistant summary. Uses
 * print + JSON mode (`-p --mode json`) with `--approve` so it runs unattended.
 *
 * The (untrusted) prompt is fed over stdin, never as an argv positional, so a
 * prompt beginning with `-`/`--` can't be mis-parsed as a Pi CLI flag (Pi has no
 * `--` end-of-options terminator, so a positional `-foo` errors as "Unknown
 * option"). Pi's print mode reads the prompt from piped stdin; we write it and
 * close the pipe so Pi gets an immediate EOF and proceeds (an open, never-closed
 * stdin pipe would make print mode block forever waiting for EOF).
 */
export function runPi(opts: {
  cwd: string
  model: string
  userPrompt: string
  sessionToken: string
  /** Aborting this kills Pi (the job's inactivity/max-duration watchdog). */
  signal?: AbortSignal
  /** Called on every chunk of Pi output, so the watchdog sees the agent is alive. */
  onActivity?: () => void
  /** Called with the latest subtask counts each time Pi updates its todo list. */
  onProgress?: (progress: TodoProgress) => void
  /** No-progress guard bounds; defaults to the env-configured limits. */
  guardLimits?: ProgressGuardLimits
  /** Whether this run is expected to edit files (false for assess-only runs like the merger). */
  expectsEdits?: boolean
}): Promise<PiRunOutcome> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('pi aborted before start'))
      return
    }
    const child = spawn(
      'pi',
      ['-p', '--mode', 'json', '--model', `proxy/${opts.model}`, '--approve'],
      {
        cwd: opts.cwd,
        env: { ...process.env, PI_PROXY_TOKEN: opts.sessionToken },
        // stdin is piped (not 'ignore') so the prompt is delivered out-of-band
        // rather than on argv — see the function doc for the injection rationale.
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    // Hand Pi the prompt over stdin, then close it so print mode sees EOF and
    // runs. Ignore stdin errors (e.g. EPIPE if Pi exits before reading): the
    // 'close'/'error' handlers below own the actual failure reporting.
    child.stdin.on('error', () => {})
    child.stdin.end(opts.userPrompt)
    let stdout = ''
    let stderr = ''
    let aborted = false
    // Set when the no-progress guard kills Pi; carries the diagnostic the run
    // fails with (distinct from an external watchdog abort).
    let guardReason: string | undefined
    // Pi's json mode is strict LF-framed JSONL; buffer partial lines across
    // chunks so we only ever parse complete records for progress + the guard.
    let lineBuffer = ''
    const guard = new ProgressGuard(
      opts.guardLimits ?? progressGuardLimitsFromEnv(),
      opts.expectsEdits ?? true,
    )

    // SIGTERM first, then SIGKILL if Pi ignores it. Shared by the watchdog abort
    // and the no-progress guard; the `close` handler turns it into a rejection.
    const killChild = (): void => {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 5_000).unref()
    }

    // Parse each complete JSONL record once, feeding both the todo-progress
    // emitter and the no-progress guard. A tripped guard kills Pi with a
    // diagnostic the run then fails on.
    const processLine = (line: string): void => {
      if (!line.startsWith('{')) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (opts.onProgress) {
        const progress = parseTodoProgress(event)
        if (progress) opts.onProgress(progress)
      }
      if (!guardReason && !aborted) {
        const reason = guard.observe(event)
        if (reason) {
          guardReason = reason
          killChild()
        }
      }
    }

    const consumeStdout = (text: string): void => {
      lineBuffer += text
      let nl = lineBuffer.indexOf('\n')
      while (nl !== -1) {
        const line = lineBuffer.slice(0, nl).trim()
        lineBuffer = lineBuffer.slice(nl + 1)
        nl = lineBuffer.indexOf('\n')
        processLine(line)
      }
    }

    // When the watchdog aborts, terminate Pi: the `close` handler then rejects
    // with the abort reason.
    const onAbort = (): void => {
      aborted = true
      killChild()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const onChunk = (chunk: Buffer, sink: 'out' | 'err'): void => {
      const text = chunk.toString()
      if (sink === 'out') {
        stdout += text
        consumeStdout(text)
      } else stderr += text
      // Any output means progress: reset the inactivity watchdog.
      opts.onActivity?.()
    }
    child.stdout.on('data', (chunk: Buffer) => onChunk(chunk, 'out'))
    child.stderr.on('data', (chunk: Buffer) => onChunk(chunk, 'err'))
    child.on('error', (error) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (guardReason) {
        const tail = redactSecrets(stderr.trim()).slice(-700)
        reject(new Error(tail ? `${guardReason} Agent stderr: ${tail}` : guardReason))
      } else if (aborted) {
        reject(
          new Error(
            opts.signal?.reason instanceof Error ? opts.signal.reason.message : 'pi aborted',
          ),
        )
      } else if (code === 0) {
        const tail = redactSecrets(stderr.trim()).slice(-1500)
        resolve({ ...summarizePiRun(stdout), ...(tail ? { stderrTail: tail } : {}) })
      } else {
        reject(new Error(`pi exited with code ${code}: ${(stderr || stdout).slice(-500)}`))
      }
    })
  })
}

/** Parse Pi's LF-framed JSONL stdout into its event records, skipping noise. */
function parsePiEvents(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    try {
      events.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // Not a JSON event line; skip.
    }
  }
  return events
}

/**
 * Pi's assistant summary plus {@link PiRunStats}, derived from one pass over its
 * output — the canonical close-of-run signal the harness uses both to report the
 * answer and to detect a no-op run (the agent never acted).
 */
export function summarizePiRun(stdout: string): PiRunOutcome {
  const events = parsePiEvents(stdout)
  return { summary: summaryFromEvents(events, stdout), stats: statsFromEvents(events) }
}

/**
 * Count what the agent actually did. Prefers the canonical `agent_end`
 * transcript (assistant `toolCall` parts + text); falls back to the streamed
 * `tool_execution_end` / `message_end` events when no terminal transcript was
 * emitted, so a no-op is never mistaken for a real run because of a schema tweak.
 */
function statsFromEvents(events: Record<string, unknown>[]): PiRunStats {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'agent_end' && Array.isArray(e.messages)) {
      return statsFromMessages(e.messages as unknown[])
    }
  }
  let toolCalls = 0
  let toolResults = 0
  let assistantChars = 0
  for (const e of events) {
    if (e.type === 'tool_execution_end') {
      toolCalls++
    } else if (e.type === 'message_end' && isObject(e.message)) {
      const m = e.message
      if (m.role === 'assistant') assistantChars += messageText(m).length
      else if (m.role === 'toolResult') toolResults++
    }
  }
  // The same call can surface as both a `tool_execution_end` and a toolResult
  // `message_end`; prefer the former and only fall back to toolResult counts.
  return { toolCalls: toolCalls || toolResults, assistantChars }
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

/**
 * Extract the assistant's final summary from Pi's JSON-lines output. Pi emits a
 * terminal `agent_end` event whose `messages` is the full transcript, so the
 * last assistant message there is the canonical answer. Falls back to scanning
 * `message_end` events, then to a raw tail, so a schema tweak never loses output.
 */
export function parsePiOutput(stdout: string): string {
  return summaryFromEvents(parsePiEvents(stdout), stdout)
}

/** Shared summary extraction over already-parsed events (see {@link parsePiOutput}). */
function summaryFromEvents(events: Record<string, unknown>[], stdout: string): string {
  // Preferred: the final transcript from the last agent_end event.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'agent_end' && Array.isArray(e.messages)) {
      const text = lastAssistantText(e.messages as unknown[])
      if (text) return text
    }
  }

  // Fallback: assistant text accumulated from message_end events.
  const parts: string[] = []
  for (const e of events) {
    if (
      e.type === 'message_end' &&
      typeof e.message === 'object' &&
      e.message !== null &&
      (e.message as { role?: unknown }).role === 'assistant'
    ) {
      const text = messageText(e.message)
      if (text) parts.push(text)
    }
  }
  const joined = parts.join('\n').trim()
  if (joined) return joined

  // Nothing structured matched — return a trimmed tail of the raw output.
  return stdout.trim().slice(-2000)
}

/** The text of the last assistant message in a transcript, or '' if none. */
function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (typeof m === 'object' && m !== null && (m as { role?: unknown }).role === 'assistant') {
      const text = messageText(m)
      if (text) return text
    }
  }
  return ''
}

/** Join the text parts of a Pi message whose content is a string or parts array. */
function messageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
      .trim()
  }
  return ''
}
