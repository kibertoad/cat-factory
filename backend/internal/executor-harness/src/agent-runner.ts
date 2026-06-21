import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PiRunOutcome, PiRunStats, TodoProgress } from './pi.js'

// The alternate (subscription) harness runners. The Pi harness reaches models
// through the LLM proxy with a model-locked session token; the Claude Code and
// Codex harnesses instead authenticate with a stored subscription OAuth token and
// talk DIRECT to the vendor. Everything around the inner loop — the HTTP job
// server, JobRegistry watchdogs, git clone/push, the handlers — is harness-
// agnostic, so only this inner "run the CLI" step differs.
//
// Each runner mirrors `runPi`'s contract: stream the CLI's JSON events, feed
// `onActivity` (inactivity watchdog) and `onProgress` (subtask counts) the way Pi
// does, and return a {@link PiRunOutcome}. Because the proxy never sees this
// traffic, the runners also lift per-turn token usage out of the CLI event stream
// onto the outcome, which the backend uses for usage-aware token rotation and
// telemetry. Event-schema details vary by CLI version, so the extractors below are
// deliberately defensive and degrade gracefully when a field is absent.

/** Which subscription harness to run (the Pi harness uses `runPi` directly). */
export type SubscriptionHarness = 'claude-code' | 'codex'

export interface SubscriptionRunOptions {
  /** Prepared working directory (cloned/scaffolded by the caller). */
  cwd: string
  /** Real vendor model id, e.g. `claude-opus-4-8` / `gpt-5.5-codex`. */
  model: string
  /** Composed role + best-practice fragments, supplied as the system prompt. */
  systemPrompt: string
  /** The concrete task prompt handed to the CLI over stdin. */
  userPrompt: string
  /** The decrypted subscription credential: an OAuth token (claude) or auth.json blob (codex). */
  subscriptionToken: string
  /**
   * Anthropic-compatible base URL for a non-Anthropic Claude-Code vendor (GLM/Kimi).
   * Present ⇒ ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN; absent ⇒ CLAUDE_CODE_OAUTH_TOKEN.
   */
  subscriptionBaseUrl?: string
  /** Aborting this kills the CLI (the job's inactivity/max-duration watchdog). */
  signal?: AbortSignal
  /** Called on every chunk of CLI output, so the watchdog sees the agent is alive. */
  onActivity?: () => void
  /** Called with the latest subtask counts each time the CLI updates its todo/plan list. */
  onProgress?: (progress: TodoProgress) => void
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Redact the subscription secret from any text before it is logged/returned. */
function redact(text: string, secret: string): string {
  if (!secret) return text
  return text.split(secret).join('***')
}

/**
 * Drive one CLI subprocess to completion, streaming LF-framed JSONL from stdout
 * through `onEvent`. Mirrors `runPi`'s lifecycle: prompt over stdin (out-of-band,
 * never argv), `onActivity` on every chunk, abort kills the child, and the close
 * handler resolves/rejects. The caller's `onEvent` accumulates the outcome.
 */
function streamCli(
  command: string,
  args: string[],
  opts: SubscriptionRunOptions,
  env: Record<string, string>,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<{ stderrTail: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error(`${command} aborted before start`))
      return
    }
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.on('error', () => {})
    child.stdin.end(opts.userPrompt)

    let stderr = ''
    let aborted = false
    let lineBuffer = ''

    const killChild = (): void => {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 5_000).unref()
    }

    const processLine = (line: string): void => {
      if (!line.startsWith('{')) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      try {
        onEvent(event)
      } catch {
        // A faulty observer must never break the run.
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

    const onAbort = (): void => {
      aborted = true
      killChild()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      opts.onActivity?.()
      consumeStdout(chunk.toString())
    })
    child.stderr.on('data', (chunk: Buffer) => {
      opts.onActivity?.()
      stderr += chunk.toString()
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000)
    })

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (lineBuffer.trim()) processLine(lineBuffer.trim())
      const stderrTail = redact(stderr, opts.subscriptionToken).slice(-700)
      if (aborted) {
        reject(new Error('agent run aborted by watchdog'))
        return
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderrTail}`))
        return
      }
      resolve({ stderrTail })
    })
  })
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/**
 * Run the Claude Code CLI headlessly against `opts.cwd`, authenticated with the
 * leased subscription OAuth token (CLAUDE_CODE_OAUTH_TOKEN), talking direct to
 * api.anthropic.com. Streams `--output-format stream-json`, mapping the
 * `TodoWrite` tool calls onto subtask progress and the terminal `result` event
 * onto the summary + usage.
 */
export async function runClaudeCode(opts: SubscriptionRunOptions): Promise<PiRunOutcome> {
  const stats: PiRunStats = { toolCalls: 0, assistantChars: 0 }
  let summary = ''
  let usage: { inputTokens: number; outputTokens: number } | undefined

  const onEvent = (event: Record<string, unknown>): void => {
    const type = event.type
    if (type === 'assistant' && isObject(event.message)) {
      const content = (event.message as Record<string, unknown>).content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isObject(block)) continue
          if (block.type === 'text' && typeof block.text === 'string') {
            stats.assistantChars += block.text.length
          }
          if (block.type === 'tool_use') {
            stats.toolCalls += 1
            if (block.name === 'TodoWrite' && opts.onProgress) {
              const progress = todosToProgress((block.input as Record<string, unknown>)?.todos)
              if (progress) opts.onProgress(progress)
            }
          }
        }
      }
    } else if (type === 'result') {
      if (typeof event.result === 'string') summary = event.result
      usage = claudeUsage(event.usage) ?? usage
    }
  }

  // Anthropic itself authenticates with the subscription OAuth token; a
  // non-Anthropic Claude-Code vendor (GLM via Z.ai, Kimi via Moonshot) points
  // Claude Code at its Anthropic-compatible endpoint with an auth-token key.
  const env: Record<string, string> = opts.subscriptionBaseUrl
    ? {
        ANTHROPIC_BASE_URL: opts.subscriptionBaseUrl,
        ANTHROPIC_AUTH_TOKEN: opts.subscriptionToken,
      }
    : { CLAUDE_CODE_OAUTH_TOKEN: opts.subscriptionToken }

  const { stderrTail } = await streamCli(
    'claude',
    [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--model',
      opts.model,
      '--append-system-prompt',
      opts.systemPrompt,
    ],
    opts,
    env,
    onEvent,
  )

  return { summary, stats, stderrTail, ...(usage ? { usage } : {}) }
}

/** Map Claude Code's `TodoWrite` todos array onto subtask counts. */
function todosToProgress(todos: unknown): TodoProgress | undefined {
  if (!Array.isArray(todos)) return undefined
  const items = todos.filter(isObject).map((t) => ({
    label: typeof t.content === 'string' ? t.content : String(t.content ?? ''),
    status: normalizeStatus(t.status),
  }))
  const completed = items.filter((i) => i.status === 'completed').length
  const inProgress = items.filter((i) => i.status === 'in_progress').length
  return { completed, inProgress, total: items.length, items }
}

function normalizeStatus(status: unknown): 'pending' | 'in_progress' | 'completed' {
  if (status === 'completed') return 'completed'
  if (status === 'in_progress') return 'in_progress'
  return 'pending'
}

function claudeUsage(raw: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (!isObject(raw)) return undefined
  const input = numberOf(raw.input_tokens) + numberOf(raw.cache_read_input_tokens)
  const output = numberOf(raw.output_tokens)
  if (input === 0 && output === 0) return undefined
  return { inputTokens: input, outputTokens: output }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/**
 * Run the Codex CLI headlessly against `opts.cwd`, authenticated with the leased
 * ChatGPT `auth.json` bundle written to an isolated CODEX_HOME, talking direct to
 * the ChatGPT backend. Streams `codex exec --json`, mapping plan/todo updates onto
 * subtask progress and the terminal turn's usage onto the outcome.
 */
export async function runCodex(opts: SubscriptionRunOptions): Promise<PiRunOutcome> {
  const stats: PiRunStats = { toolCalls: 0, assistantChars: 0 }
  let summary = ''
  let usage: { inputTokens: number; outputTokens: number } | undefined

  // Codex reads its credentials from $CODEX_HOME/auth.json with file-backed
  // storage. Write the leased bundle into an isolated, per-run home under the
  // workspace so concurrent jobs don't share credentials.
  const codexHome = join(opts.cwd, '.codex-home')
  await mkdir(codexHome, { recursive: true })
  await writeFile(join(codexHome, 'auth.json'), opts.subscriptionToken, { mode: 0o600 })
  await writeFile(join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "file"\n', 'utf8')

  const onEvent = (event: Record<string, unknown>): void => {
    const type = typeof event.type === 'string' ? event.type : ''
    if (type.includes('agent_message') || type === 'item.completed') {
      const text = extractText(event)
      if (text) {
        stats.assistantChars += text.length
        summary = text
      }
    }
    if (type.includes('tool') || type.includes('command') || type.includes('exec')) {
      stats.toolCalls += 1
    }
    const progress = codexPlanProgress(event)
    if (progress && opts.onProgress) opts.onProgress(progress)
    const turnUsage = codexUsage(event)
    if (turnUsage) usage = turnUsage
  }

  const { stderrTail } = await streamCli(
    'codex',
    ['exec', '--json', '--skip-git-repo-check', '--model', opts.model, '-'],
    opts,
    { CODEX_HOME: codexHome },
    onEvent,
  )

  return { summary, stats, stderrTail, ...(usage ? { usage } : {}) }
}

/** Best-effort: pull a textual message out of a Codex event. */
function extractText(event: Record<string, unknown>): string | undefined {
  if (typeof event.message === 'string') return event.message
  if (typeof event.text === 'string') return event.text
  if (isObject(event.item)) {
    const item = event.item as Record<string, unknown>
    if (typeof item.text === 'string') return item.text
    if (typeof item.message === 'string') return item.message
  }
  return undefined
}

/** Best-effort: map a Codex `update_plan`/plan event onto subtask counts. */
function codexPlanProgress(event: Record<string, unknown>): TodoProgress | undefined {
  const plan =
    (isObject(event.plan) ? event.plan : undefined) ??
    (isObject(event.item) && Array.isArray((event.item as Record<string, unknown>).plan)
      ? { steps: (event.item as Record<string, unknown>).plan }
      : undefined)
  const steps = isObject(plan) ? plan.steps : Array.isArray(event.steps) ? event.steps : undefined
  if (!Array.isArray(steps)) return undefined
  const items = steps.filter(isObject).map((s) => ({
    label: typeof s.step === 'string' ? s.step : String(s.step ?? s.content ?? ''),
    status: normalizeStatus(s.status),
  }))
  if (items.length === 0) return undefined
  const completed = items.filter((i) => i.status === 'completed').length
  const inProgress = items.filter((i) => i.status === 'in_progress').length
  return { completed, inProgress, total: items.length, items }
}

/** Best-effort: pull token usage out of a Codex turn-completed event. */
function codexUsage(
  event: Record<string, unknown>,
): { inputTokens: number; outputTokens: number } | undefined {
  const raw = isObject(event.usage)
    ? event.usage
    : isObject(event.info) && isObject((event.info as Record<string, unknown>).usage)
      ? ((event.info as Record<string, unknown>).usage as Record<string, unknown>)
      : undefined
  if (!isObject(raw)) return undefined
  const input = numberOf(raw.input_tokens) + numberOf(raw.cached_input_tokens)
  const output = numberOf(raw.output_tokens)
  if (input === 0 && output === 0) return undefined
  return { inputTokens: input, outputTokens: output }
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Dispatch to the configured subscription harness runner. */
export function runSubscriptionHarness(
  harness: SubscriptionHarness,
  opts: SubscriptionRunOptions,
): Promise<PiRunOutcome> {
  return harness === 'claude-code' ? runClaudeCode(opts) : runCodex(opts)
}
