import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

/** Redact every known secret value from text before it is logged/returned. */
export function redactAll(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) {
    // Guard against scrubbing trivially-short values that would mangle output.
    if (secret.length >= 6) out = out.split(secret).join('***')
  }
  return out
}

// Only harvest token-like JSON leaves: real OAuth access/refresh tokens and ids are
// long, while short values (`auth_mode: "chatgpt"`, `type: "oauth"`, …) are non-secret
// words that would over-redact legitimate error text if scrubbed. 12 chars is a safe
// floor below which a value is not a credential.
const MIN_HARVEST_LEN = 12

/** Recursively harvest token-like string leaves from a parsed JSON value. */
function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (value.length >= MIN_HARVEST_LEN) out.add(value)
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out)
  }
}

/**
 * The set of secret strings to scrub from a run's stderr/output. For Claude (and the
 * Anthropic-compatible vendors GLM/Kimi/DeepSeek) the credential IS the token string,
 * so the whole-string entry covers it. For Codex the credential is a whole `auth.json`
 * blob, so we ALSO scrub every string value parsed out of it (access/refresh tokens,
 * ids): a token echoed on its OWN — not as part of the whole blob — would otherwise
 * slip past a whole-blob-only match and leak into an error message.
 */
export function secretsToRedact(subscriptionToken: string): string[] {
  const secrets = new Set<string>()
  if (subscriptionToken) secrets.add(subscriptionToken)
  try {
    collectStrings(JSON.parse(subscriptionToken), secrets)
  } catch {
    // Not JSON (a Claude OAuth token / API key) — the whole-string entry covers it.
  }
  return [...secrets]
}

/**
 * Drive one CLI subprocess to completion, streaming LF-framed JSONL from stdout
 * through `onEvent`. Mirrors `runPi`'s lifecycle: prompt over stdin (out-of-band,
 * never argv), `onActivity` on every chunk, abort kills the child, and the close
 * handler resolves/rejects. The caller's `onEvent` accumulates the outcome.
 *
 * `prompt` is fed over stdin: for Claude Code that is just the task prompt (the
 * system prompt rides `--append-system-prompt`); for Codex — which has no
 * system-prompt flag — the caller prepends the composed system prompt to it so
 * the role + best-practice context is not lost.
 */
function streamCli(
  command: string,
  args: string[],
  prompt: string,
  opts: SubscriptionRunOptions,
  env: Record<string, string>,
  secrets: string[],
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
    child.stdin.end(prompt)

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
      const stderrTail = redactAll(stderr, secrets).slice(-700)
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

  // Claude Code persists user config/credentials under its config dir; point that at
  // an isolated, per-run temp dir OUTSIDE the cloned checkout (`opts.cwd`). Otherwise
  // the agents that finish with `git add -A` (blueprint/requirements/bootstrap) could
  // stage a stray `.claude/` directory — and any cached credential in it — into the
  // pushed branch. Mirrors the Codex CODEX_HOME isolation below; removed in `finally`.
  const configHome = await mkdtemp(join(tmpdir(), 'cf-claude-'))

  // The config dir is brand-new every run, so Claude Code would otherwise treat this
  // as a first launch and BLOCK on the interactive onboarding / "trust this folder" /
  // bypass-permissions acknowledgement prompts — which never get answered headlessly,
  // hanging the job until the watchdog kills it. Pre-seed the config that marks those
  // as already accepted so `-p` starts straight into the run. Best-effort: written
  // before the CLI starts; unknown keys are harmless if a CLI version ignores them.
  await writeFile(
    join(configHome, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      hasTrustDialogAccepted: true,
    }),
    { mode: 0o600 },
  ).catch(() => {})

  // Anthropic itself authenticates with the subscription OAuth token; a
  // non-Anthropic Claude-Code vendor (GLM via Z.ai, Kimi via Moonshot, DeepSeek)
  // points Claude Code at its Anthropic-compatible endpoint with an auth-token key.
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: configHome,
    ...(opts.subscriptionBaseUrl
      ? {
          ANTHROPIC_BASE_URL: opts.subscriptionBaseUrl,
          ANTHROPIC_AUTH_TOKEN: opts.subscriptionToken,
        }
      : { CLAUDE_CODE_OAUTH_TOKEN: opts.subscriptionToken }),
  }

  try {
    const { stderrTail } = await streamCli(
      'claude',
      [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        // The per-run container IS the sandbox, and the run is fully headless (no one
        // to approve a tool call) — so bypass permissions entirely. `acceptEdits`
        // would auto-accept file edits but still gate Bash, which in `-p` mode is then
        // denied, leaving the agent unable to run builds/tests/git to verify its work.
        '--permission-mode',
        'bypassPermissions',
        '--model',
        opts.model,
        '--append-system-prompt',
        opts.systemPrompt,
      ],
      opts.userPrompt,
      opts,
      env,
      secretsToRedact(opts.subscriptionToken),
      onEvent,
    )

    return { summary, stats, stderrTail, ...(usage ? { usage } : {}) }
  } finally {
    // Never leave the config dir (and any cached credential) on disk past the run.
    await rm(configHome, { recursive: true, force: true }).catch(() => {})
  }
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
  // Count every input bucket Anthropic bills: fresh input plus BOTH cache reads and
  // cache writes (cache_creation_input_tokens), which are real consumed tokens — and
  // are the dominant share on a long agent run. Omitting them under-weights a token's
  // true load in the usage-aware rotation window.
  const input =
    numberOf(raw.input_tokens) +
    numberOf(raw.cache_read_input_tokens) +
    numberOf(raw.cache_creation_input_tokens)
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
 * subtask progress and the running cumulative token usage onto the outcome.
 */
export async function runCodex(opts: SubscriptionRunOptions): Promise<PiRunOutcome> {
  const stats: PiRunStats = { toolCalls: 0, assistantChars: 0 }
  let summary = ''
  let usage: { inputTokens: number; outputTokens: number } | undefined

  // Codex reads its credentials from $CODEX_HOME/auth.json with file-backed
  // storage. CRITICAL: this home must live OUTSIDE the cloned checkout (`opts.cwd`)
  // — the blueprint/requirements/conflict-resolver handlers finish with
  // `git add -A` + push, which would otherwise stage and publish the decrypted
  // subscription `auth.json` (access + refresh tokens) to the PR branch. An
  // isolated, per-run temp dir keeps the credential out of the working tree and is
  // removed in `finally`.
  //
  // KNOWN LIMITATION: Codex refreshes its OAuth access token in-place by rewriting
  // this `auth.json` mid-run. Because the home is a per-run temp dir wiped in
  // `finally`, that refreshed credential is discarded and never written back to the
  // pool — there is no write-back path. The stored bundle keeps working as long as
  // its refresh token stays valid (ChatGPT refresh tokens are long-lived and reused,
  // not rotated per refresh today), so each run re-refreshes from the same stored
  // copy; if OpenAI ever rotates refresh tokens on use, a pooled Codex token would
  // eventually need to be re-connected by the user. Claude OAuth tokens (from
  // `claude setup-token`) are long-lived and unaffected.
  const codexHome = await mkdtemp(join(tmpdir(), 'cf-codex-'))
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

  // Codex has no system-prompt flag, so fold the composed role + best-practice
  // context into the prompt itself (Claude Code instead rides --append-system-prompt).
  const prompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n---\n\n${opts.userPrompt}`
    : opts.userPrompt

  try {
    const { stderrTail } = await streamCli(
      'codex',
      [
        'exec',
        '--json',
        '--skip-git-repo-check',
        // The per-run container IS the sandbox; let Codex write files and reach the
        // vendor unrestricted, with no approval prompts (the run is headless).
        '--dangerously-bypass-approvals-and-sandbox',
        '--model',
        opts.model,
        '-',
      ],
      prompt,
      opts,
      { CODEX_HOME: codexHome },
      secretsToRedact(opts.subscriptionToken),
      onEvent,
    )

    return { summary, stats, stderrTail, ...(usage ? { usage } : {}) }
  } finally {
    // Never leave the decrypted credential on disk past the run.
    await rm(codexHome, { recursive: true, force: true }).catch(() => {})
  }
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

/**
 * Best-effort: pull token usage out of a Codex usage event. Codex `exec --json`
 * reports a running CUMULATIVE total on `token_count` events under
 * `info.total_token_usage` (it also carries the per-turn `last_token_usage`); older /
 * other shapes put it on `usage` / `info.usage` directly. We read the cumulative
 * total when present so the caller can simply overwrite (not sum) — summing
 * cumulative totals across events would multiply-count. Checked most-likely first.
 */
function codexUsage(
  event: Record<string, unknown>,
): { inputTokens: number; outputTokens: number } | undefined {
  const info = isObject(event.info) ? (event.info as Record<string, unknown>) : undefined
  const raw =
    (info && isObject(info.total_token_usage) ? info.total_token_usage : undefined) ??
    (isObject(event.total_token_usage) ? event.total_token_usage : undefined) ??
    (isObject(event.usage) ? event.usage : undefined) ??
    (info && isObject(info.usage) ? info.usage : undefined)
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
