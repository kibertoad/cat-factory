import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  claudeAssistantContent,
  claudeCallUsage,
  isObject,
  numberOf,
  redactBody,
} from './claude-stream.js'
import type { Logger } from './logger.js'
import type { HarnessCallMetric, PiRunOutcome, PiRunStats, TodoProgress } from './pi.js'
import { killChildProcess, spawnDetached } from './process.js'
import { redact, secretsToRedact } from './redact.js'
import { createSliceTracker, pickProgress, startSubagentWatcher } from './subagents.js'
import { assertOnboardingKeysCurrent, writeOnboardingPreseed } from './onboarding-preseed.js'
import { retainSessionTranscripts } from './transcript-retention.js'

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
  /**
   * The decrypted subscription credential: an OAuth token (claude) or auth.json blob
   * (codex). Omitted when `ambientAuth` is set — the CLI uses the developer's own login.
   */
  subscriptionToken?: string
  /**
   * Anthropic-compatible base URL for a non-Anthropic Claude-Code vendor (GLM/Kimi).
   * Present ⇒ ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN; absent ⇒ CLAUDE_CODE_OAUTH_TOKEN.
   */
  subscriptionBaseUrl?: string
  /**
   * Native local execution: run the developer's ALREADY-INSTALLED CLI with its OWN
   * ambient login (`~/.claude` / `~/.codex`) — no leased credential, no isolated config
   * home. Set ONLY by the local native transport (which runs the harness as a host
   * process); a no-op everywhere else. The agent then runs with the user's personal
   * subscription, unsandboxed, on their own machine — the explicit trade for skipping the
   * container.
   */
  ambientAuth?: boolean
  /**
   * A repo-sourced Claude Skill to install natively before launch (repo-sourced Claude Skills,
   * slice 2). The claude-code runner writes it to `CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md`
   * (+ resource files) so the CLI loads it; the codex runner ignores it (codex reads the
   * checkout's `.cat-context/skill/`, materialised by the caller). Absent ⇒ no skill installed.
   */
  skill?: {
    name: string
    description: string
    instructions: string
    resources: { relPath: string; content: string }[]
  }
  /** Aborting this kills the CLI (the job's inactivity/max-duration watchdog). */
  signal?: AbortSignal
  /** Called on every chunk of CLI output, so the watchdog sees the agent is alive. */
  onActivity?: () => void
  /** Called with the latest subtask counts each time the CLI updates its todo/plan list. */
  onProgress?: (progress: TodoProgress) => void
  /**
   * The per-job child logger (jobId/repo/branch correlation). Threaded so the retained
   * session-transcript path is logged for the run when the isolated config home is torn down.
   */
  log?: Logger
}

/**
 * Fallback token attribution: if a CLI reported a cumulative total but no per-turn
 * usage (so every captured call has zero tokens), pin the whole total onto the LAST
 * call rather than dropping it — the run's tokens are still accounted, just not split
 * per turn. A no-op when the calls already carry per-turn tokens.
 */
function attributeCumulativeUsage(
  calls: HarnessCallMetric[],
  usage: { inputTokens: number; outputTokens: number } | undefined,
): void {
  if (!usage || calls.length === 0) return
  const anyTokens = calls.some((c) => c.inputTokens > 0 || c.outputTokens > 0)
  if (anyTokens) return
  const last = calls[calls.length - 1]!
  last.inputTokens = usage.inputTokens
  last.outputTokens = usage.outputTokens
}

/**
 * Drive one CLI subprocess to completion, streaming LF-framed JSONL from stdout
 * through `onEvent`. Mirrors `runPi`'s lifecycle: prompt over stdin (out-of-band,
 * never argv), `onActivity` on every chunk, abort kills the child, and the close
 * handler resolves/rejects. The caller's `onEvent` accumulates the outcome.
 *
 * `prompt` is fed over stdin: for Claude Code that is normally just the task prompt (the
 * system prompt rides `--append-system-prompt`), unless the system prompt is too large for
 * argv, in which case it is folded into `prompt` (see `carryClaudeSystemPrompt`); for Codex
 * — which has no system-prompt flag — the caller always prepends the composed system prompt
 * so the role + best-practice context is not lost.
 */
function streamCli(
  cli: { command: string; args: string[] },
  prompt: string,
  opts: SubscriptionRunOptions,
  env: Record<string, string>,
  secrets: string[],
  onEvent: (event: Record<string, unknown>) => void,
): Promise<{ stderrTail: string }> {
  const { command, args } = cli
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error(`${command} aborted before start`))
      return
    }
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group (POSIX) so killChildProcess reaps the CLI's grandchildren too.
      detached: spawnDetached,
    })
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)

    let stderr = ''
    let aborted = false
    let lineBuffer = ''

    const killChild = (): void => killChildProcess(child)

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
      const stderrTail = redact(stderr, secrets).slice(-700)
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

/**
 * Fold a composed system prompt into the task prompt so the role + best-practice context
 * rides stdin as a single user turn. Used by the Codex runner (no system-prompt flag) and
 * by the Claude runner's argv-overflow fallback. Empty system prompt ⇒ the task prompt is
 * returned unchanged.
 */
function foldSystemPrompt(systemPrompt: string, userPrompt: string): string {
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt
}

/**
 * Linux caps a SINGLE argv string at MAX_ARG_STRLEN (32 pages = 128 KiB) — a per-string limit,
 * distinct from (and reached long before) the far larger total ARG_MAX for argv + env combined. A
 * system prompt with best-practice fragments folded in can exceed that per-string cap, and `execve`
 * then fails the whole spawn with `E2BIG` before the agent runs at all — the failure mode seen on
 * the `pr-reviewer` step (a ~150 KiB composed prompt). The binding constraint is that per-string
 * cap; 96 KiB stays comfortably under 128 KiB so the system-prompt argv can never approach it.
 */
const MAX_ARGV_STRING_BYTES = 96 * 1024

/**
 * Decide how the Claude Code runner carries the composed system prompt. Small prompts ride
 * `--append-system-prompt` (a real system turn, cacheable) as before; a prompt too large for a
 * single argv string is instead folded into the stdin task prompt (like the Codex runner), which
 * has no size ceiling. Pure so the branch is unit-testable without spawning the CLI.
 */
export function carryClaudeSystemPrompt(
  systemPrompt: string,
  userPrompt: string,
): { appendArgs: string[]; prompt: string; folded: boolean } {
  if (Buffer.byteLength(systemPrompt, 'utf8') <= MAX_ARGV_STRING_BYTES) {
    return {
      appendArgs: ['--append-system-prompt', systemPrompt],
      prompt: userPrompt,
      folded: false,
    }
  }
  return { appendArgs: [], prompt: foldSystemPrompt(systemPrompt, userPrompt), folded: true }
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
/**
 * Write a repo-sourced skill as a NATIVE Claude Code skill under `<skillsRoot>/<name>/`: a
 * `SKILL.md` (YAML frontmatter `name`/`description` + the instructions body, the format the CLI
 * expects) plus every resource file at its path within the skill directory. Resource sub-paths
 * were sanitized at the job boundary (no traversal), so nested dirs are created as needed.
 *
 * The frontmatter `name`/`description` values are emitted as JSON-encoded (double-quoted) YAML
 * scalars, not bare plain scalars: an author's description routinely contains `: ` (colon-space)
 * or a leading YAML indicator (`#`, `-`, `[`, `{`, `"`, …), which is invalid as a plain scalar and
 * would make the CLI fail to parse the frontmatter and silently skip the skill. A JSON string is a
 * valid YAML double-quoted scalar, so quoting makes the manifest robust to arbitrary text.
 */
async function writeNativeSkill(
  skillsRoot: string,
  skill: NonNullable<SubscriptionRunOptions['skill']>,
): Promise<void> {
  const dir = join(skillsRoot, skill.name)
  await mkdir(dir, { recursive: true })
  const name = JSON.stringify(skill.name)
  const description = JSON.stringify(skill.description.replace(/\r?\n/g, ' '))
  const frontmatter = `---\nname: ${name}\ndescription: ${description}\n---\n`
  await writeFile(join(dir, 'SKILL.md'), `${frontmatter}\n${skill.instructions}\n`, 'utf8')
  for (const resource of skill.resources) {
    const dest = join(dir, resource.relPath)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, resource.content, 'utf8')
  }
}

export async function runClaudeCode(opts: SubscriptionRunOptions): Promise<PiRunOutcome> {
  const stats: PiRunStats = { toolCalls: 0, assistantChars: 0 }
  let summary = ''
  let usage: { inputTokens: number; outputTokens: number } | undefined

  // Decide how the composed system prompt is carried up front, so the telemetry seed below
  // reflects what actually reaches the model: a small prompt rides `--append-system-prompt`
  // (a real system turn), while an argv-overflowing prompt is folded into the first user turn
  // — in which case NO system turn of ours is sent (the `E2BIG` fallback).
  const { appendArgs, prompt, folded } = carryClaudeSystemPrompt(opts.systemPrompt, opts.userPrompt)
  if (folded) {
    opts.log?.warn('system prompt exceeds argv limit; folding into the task prompt', {
      bytes: Buffer.byteLength(opts.systemPrompt, 'utf8'),
    })
  }

  // Reconstruct the full per-call request/response bodies for telemetry from the
  // stream. `--output-format stream-json --verbose` emits each turn as a near-verbatim
  // Anthropic Messages envelope, so `assistant` events carry the complete response
  // (text + tool_use blocks + usage), and `user` events carry the tool_result blocks
  // fed back — together the growing prompt transcript. We seed it with the inputs the
  // harness supplies (they never appear in the stream): the system + first user message
  // when the prompt rides argv, or a single folded user turn when it doesn't — so the
  // reconstruction never shows a system turn that was never sent. Bodies are
  // credential-scrubbed (they can echo the leased token).
  const secrets = opts.subscriptionToken ? secretsToRedact(opts.subscriptionToken) : []
  const messages: Array<{ role: string; content: unknown }> = folded
    ? [{ role: 'user', content: prompt }]
    : [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userPrompt },
      ]
  const calls: HarnessCallMetric[] = []

  // ADR 0026 D2.1 + ADR 0027 Defect B: surface live slice progress from TWO reconciled
  // sources. The parent's `Task` dispatches + their terminal tool_results DO appear on this
  // stream (only a subagent's intermediate turns don't), so `sliceTracker` derives per-slice
  // progress for the parallel-subagent shape; a parent `TodoWrite` plan (the sequential
  // shape) is tracked in `lastTodo`. `pickProgress` picks whichever is further along on each
  // update, so neither masks the other — the pr-reviewer prompt writes its todo plan ONCE
  // and never marks it done, which used to gate the slice signal off and pin progress at 0%.
  const sliceTracker = createSliceTracker()
  let lastTodo: TodoProgress | undefined
  const emitProgress = (): void => {
    if (!opts.onProgress) return
    const progress = pickProgress(lastTodo, sliceTracker.progress())
    if (progress) opts.onProgress(progress)
  }

  const onEvent = (event: Record<string, unknown>): void => {
    const type = event.type
    if (type === 'assistant' && isObject(event.message)) {
      const message = event.message as Record<string, unknown>
      const content = Array.isArray(message.content) ? message.content : []
      const { text, reasoning, toolUses } = claudeAssistantContent(content)
      stats.assistantChars += text.length
      stats.toolCalls += toolUses
      for (const block of content) {
        if (isObject(block) && block.type === 'tool_use' && block.name === 'TodoWrite') {
          const progress = todosToProgress((block.input as Record<string, unknown>)?.todos)
          if (progress) lastTodo = progress
        }
      }
      sliceTracker.onAssistant(content)
      emitProgress()
      // Record this call BEFORE appending its turn: the prompt is the history that
      // produced this response. The append-only array keeps each call's prompt a strict
      // prefix of the next, so the backend's telemetry chain delta-compresses cleanly.
      const u = claudeCallUsage(message.usage)
      calls.push({
        ...(typeof message.model === 'string' ? { model: message.model } : {}),
        promptText: redactBody(JSON.stringify(messages), secrets),
        messageCount: messages.length,
        responseText: redactBody(text, secrets),
        reasoningText: redactBody(reasoning, secrets),
        inputTokens: u.inputTokens,
        cachedInputTokens: u.cachedInputTokens,
        outputTokens: u.outputTokens,
        finishReason: typeof message.stop_reason === 'string' ? message.stop_reason : null,
      })
      messages.push({ role: 'assistant', content })
    } else if (type === 'user' && isObject(event.message)) {
      // tool_result blocks the harness fed back to the model — part of the next prompt.
      const content = (event.message as Record<string, unknown>).content
      if (Array.isArray(content)) {
        sliceTracker.onUser(content)
        emitProgress()
        messages.push({ role: 'tool', content })
      }
    } else if (type === 'result') {
      if (typeof event.result === 'string') summary = event.result
      usage = claudeUsage(event.usage) ?? usage
    }
  }

  // Native (ambient) mode: run the developer's installed `claude` with its OWN login —
  // no isolated config home, no injected credential, no onboarding pre-seed. Otherwise,
  // Claude Code persists user config/credentials under its config dir; point that at an
  // isolated, per-run temp dir OUTSIDE the cloned checkout (`opts.cwd`). Otherwise the
  // agents that finish with `git add -A` (blueprint/requirements/bootstrap) could stage a
  // stray `.claude/` directory — and any cached credential in it — into the pushed branch.
  // Mirrors the Codex CODEX_HOME isolation below; removed in `finally`.
  if (!opts.ambientAuth && !opts.subscriptionToken) {
    throw new Error('claude-code harness requires a subscription token (or ambientAuth)')
  }
  const configHome = opts.ambientAuth ? undefined : await mkdtemp(join(tmpdir(), 'cf-claude-'))

  // The config dir is brand-new every run, so Claude Code would otherwise treat this
  // as a first launch and BLOCK on the interactive onboarding / "trust this folder" /
  // bypass-permissions acknowledgement prompts — which never get answered headlessly,
  // hanging the job until the watchdog kills it. Pre-seed the config that marks those
  // as already accepted so `-p` starts straight into the run. Best-effort: written
  // before the CLI starts; unknown keys are harmless if a CLI version ignores them.
  // (Ambient mode skips this — the developer's own config is already onboarded.)
  // ADR 0026 D4: assert the pinned onboarding keys landed and log them with the CLI
  // version, so a future first-run gate this set doesn't cover (which looks identical to
  // a healthy-but-quiet subagent start) is diffable when the cold-start watchdog fires.
  if (configHome) {
    await writeOnboardingPreseed(configHome)
    await assertOnboardingKeysCurrent(configHome, process.env.CLAUDE_CLI_VERSION, opts.log)
  }

  // Repo-sourced Claude Skill (slice 2): install it as a native skill under the config dir's
  // `skills/<name>/` so the CLI discovers and can invoke it. Written to the isolated per-run
  // config home when present, else the developer's `~/.claude` (ambient/native mode). Best-effort:
  // a write failure must not wedge the run — the prompt still names the skill.
  if (opts.skill) {
    const skillsRoot = configHome
      ? join(configHome, 'skills')
      : join(homedir(), '.claude', 'skills')
    await writeNativeSkill(skillsRoot, opts.skill).catch(() => {})
  }

  // Anthropic itself authenticates with the subscription OAuth token; a
  // non-Anthropic Claude-Code vendor (GLM via Z.ai, Kimi via Moonshot, DeepSeek)
  // points Claude Code at its Anthropic-compatible endpoint with an auth-token key.
  // Ambient mode injects neither — the CLI uses the developer's logged-in `~/.claude`.
  const env: Record<string, string> = opts.ambientAuth
    ? {}
    : {
        CLAUDE_CONFIG_DIR: configHome!,
        ...(opts.subscriptionBaseUrl
          ? {
              ANTHROPIC_BASE_URL: opts.subscriptionBaseUrl,
              ANTHROPIC_AUTH_TOKEN: opts.subscriptionToken!,
            }
          : { CLAUDE_CODE_OAUTH_TOKEN: opts.subscriptionToken! }),
      }

  // ADR 0026 D3 (path corrected by ADR 0027 Defect A): while the run is live, tail the CLI's
  // subagent `*.jsonl` transcripts so a parallel-subagent review keeps the inactivity
  // heartbeat alive (any new bytes ⇒ `onActivity`) and its otherwise-invisible token spend is
  // lifted into the run's telemetry. The CLI writes them per-session under
  // `<configHome>/projects/<encoded-cwd>/<session-uuid>/subagents/*.jsonl`, so we watch the
  // `projects` tree and let the watcher discover the `subagents/` dir (the session uuid isn't
  // known up front). Ambient mode has no isolated home to watch. Best-effort — a
  // missing/renamed transcript layout just yields no extra signal.
  const subagents = configHome
    ? startSubagentWatcher(join(configHome, 'projects'), {
        ...(opts.onActivity ? { onActivity: opts.onActivity } : {}),
        secrets,
        model: opts.model,
        ...(opts.log ? { log: opts.log } : {}),
      })
    : undefined

  try {
    const { stderrTail } = await streamCli(
      {
        command: 'claude',
        args: [
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
          ...appendArgs,
        ],
      },
      prompt,
      opts,
      env,
      opts.subscriptionToken ? secretsToRedact(opts.subscriptionToken) : [],
      onEvent,
    )

    // The parent's cumulative-usage fallback applies to the PARENT calls only (before the
    // subagent calls, which carry their own per-turn tokens, are concatenated).
    attributeCumulativeUsage(calls, usage)
    // Final drain of any subagent transcript writes that landed after the last poll, then
    // fold the subagents' usage + per-call telemetry into the run's outcome — their tokens
    // never appear on the parent stream, so this is the only place they are accounted.
    await subagents?.stop()
    const subUsage = subagents?.usage() ?? { inputTokens: 0, outputTokens: 0 }
    const subCalls = subagents?.calls() ?? []
    const mergedCalls = [...calls, ...subCalls]
    // INVARIANT (do not "fix" this into a double count): the run total is the parent usage
    // PLUS the subagent usage because the two are disjoint sources. The parent `usage` here
    // is the terminal `result` event's cumulative, which covers ONLY the parent loop — the
    // ADR 0026 incident is itself the proof: a heavily subagent-parallelised review reported
    // ~0 tokens, i.e. the parent stream (and its `result` total) never included the subagent
    // spend. The subagent tokens live exclusively in the per-session `subagents/*.jsonl`
    // transcripts, which the watcher reads and nothing else does; it deliberately EXCLUDES the
    // sibling parent session transcript (whose usage `result` already totals), so neither
    // `calls` nor `usage` can already contain the subagent spend.
    const mergedUsage =
      usage || subUsage.inputTokens || subUsage.outputTokens
        ? {
            inputTokens: (usage?.inputTokens ?? 0) + subUsage.inputTokens,
            outputTokens: (usage?.outputTokens ?? 0) + subUsage.outputTokens,
          }
        : undefined
    return {
      summary,
      stats,
      stderrTail,
      ...(mergedUsage ? { usage: mergedUsage } : {}),
      ...(mergedCalls.length ? { callMetrics: mergedCalls } : {}),
    }
  } finally {
    await subagents?.stop()
    if (configHome) {
      // Lift the CLI session transcripts (`projects/`) out for short-lived retention BEFORE the
      // home is deleted — the credential lives at the home root, never in `projects/`, so this
      // keeps the debugging artifact without leaking the token. Best-effort; never throws.
      await retainSessionTranscripts(configHome, ['projects'], {
        label: 'claude-code',
        ...(opts.log ? { log: opts.log } : {}),
      })
      // Never leave the config dir (and any cached credential) on disk past the run.
      await rm(configHome, { recursive: true, force: true }).catch(() => {})
    }
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
  // Native (ambient) mode: run the developer's installed `codex` with its OWN login —
  // no isolated CODEX_HOME, no injected auth.json. Otherwise write the leased credential
  // to a per-run temp home kept OUTSIDE the checkout (and removed in `finally`).
  if (!opts.ambientAuth && !opts.subscriptionToken) {
    throw new Error('codex harness requires a subscription token (or ambientAuth)')
  }
  const codexHome = opts.ambientAuth ? undefined : await mkdtemp(join(tmpdir(), 'cf-codex-'))
  if (codexHome) {
    await writeFile(join(codexHome, 'auth.json'), opts.subscriptionToken!, { mode: 0o600 })
    await writeFile(join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "file"\n', 'utf8')
  }

  // Codex has no system-prompt flag, so fold the composed role + best-practice
  // context into the prompt itself (Claude Code instead rides --append-system-prompt,
  // falling back to this same fold when the prompt overflows argv).
  const prompt = foldSystemPrompt(opts.systemPrompt, opts.userPrompt)

  // Codex's `exec --json` is far thinner than Claude Code's stream: it surfaces only
  // flat assistant text and (on `token_count` events) the per-turn `last_token_usage`
  // plus a cumulative total. It never exposes the request transcript or structured
  // tool/command bodies, so the captured prompt is just the folded input — the response
  // text + per-turn tokens are faithful; the request side is best-effort by design.
  const secrets = opts.subscriptionToken ? secretsToRedact(opts.subscriptionToken) : []
  const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: prompt }]
  const calls: HarnessCallMetric[] = []
  let pendingText = ''

  const onEvent = (event: Record<string, unknown>): void => {
    const type = typeof event.type === 'string' ? event.type : ''
    if (
      type.includes('agent_message') ||
      (type === 'item.completed' && isCodexMessageItem(event))
    ) {
      const text = extractText(event)
      if (text) {
        stats.assistantChars += text.length
        summary = text
        pendingText = text
      }
    }
    if (type.includes('tool') || type.includes('command') || type.includes('exec')) {
      stats.toolCalls += 1
    }
    const progress = codexPlanProgress(event)
    if (progress && opts.onProgress) opts.onProgress(progress)
    const turnUsage = codexUsage(event)
    if (turnUsage) usage = turnUsage
    // A `token_count` event closes a model turn: pair its per-turn usage with the
    // assistant text seen since the previous turn as one telemetry call.
    const perTurn = codexLastTurnUsage(event)
    if (perTurn) {
      calls.push({
        model: opts.model,
        promptText: redactBody(JSON.stringify(messages), secrets),
        messageCount: messages.length,
        responseText: redactBody(pendingText, secrets),
        reasoningText: '',
        inputTokens: perTurn.inputTokens,
        cachedInputTokens: perTurn.cachedInputTokens,
        outputTokens: perTurn.outputTokens,
        finishReason: null,
      })
      if (pendingText) messages.push({ role: 'assistant', content: pendingText })
      pendingText = ''
    }
  }

  try {
    const { stderrTail } = await streamCli(
      {
        command: 'codex',
        args: [
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
      },
      prompt,
      opts,
      codexHome ? { CODEX_HOME: codexHome } : {},
      opts.subscriptionToken ? secretsToRedact(opts.subscriptionToken) : [],
      onEvent,
    )

    // Fallback for a CLI/version that never emits per-turn `last_token_usage`: record a
    // single call from the cumulative total + final text so the run is still observable.
    if (calls.length === 0 && (usage || summary)) {
      calls.push({
        model: opts.model,
        promptText: redactBody(JSON.stringify(messages), secrets),
        messageCount: messages.length,
        responseText: redactBody(summary, secrets),
        reasoningText: '',
        inputTokens: usage?.inputTokens ?? 0,
        cachedInputTokens: 0,
        outputTokens: usage?.outputTokens ?? 0,
        finishReason: null,
      })
    }
    return {
      summary,
      stats,
      stderrTail,
      ...(usage ? { usage } : {}),
      ...(calls.length ? { callMetrics: calls } : {}),
    }
  } finally {
    if (codexHome) {
      // Lift the CLI session transcripts (`sessions/`) out for short-lived retention BEFORE the
      // home is deleted — the credential (`auth.json`) lives at the home root, never in
      // `sessions/`, so this keeps the debugging artifact without leaking it. Best-effort.
      await retainSessionTranscripts(codexHome, ['sessions'], {
        label: 'codex',
        ...(opts.log ? { log: opts.log } : {}),
      })
      // Never leave the decrypted credential on disk past the run.
      await rm(codexHome, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * Whether a Codex `item.completed` event carries the model's ASSISTANT text (as
 * opposed to a command/exec/tool/reasoning item, which also carry a `text` field —
 * their command output or thinking — and must NOT be captured as the turn's response).
 * A message item's kind contains `message` (`agent_message`/`assistant_message`); an
 * item with no kind is treated as a message so older/simple shapes don't regress.
 */
function isCodexMessageItem(event: Record<string, unknown>): boolean {
  const item = isObject(event.item) ? (event.item as Record<string, unknown>) : undefined
  if (!item) return false
  const kind =
    typeof item.item_type === 'string'
      ? item.item_type
      : typeof item.type === 'string'
        ? item.type
        : ''
  return kind === '' || /message/i.test(kind)
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
 * `input_tokens` is the TOTAL prompt count (OpenAI semantics: `cached_input_tokens`
 * is a subset already inside it), so it is NOT summed with the cached share.
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
  const input = numberOf(raw.input_tokens)
  const output = numberOf(raw.output_tokens)
  if (input === 0 && output === 0) return undefined
  return { inputTokens: input, outputTokens: output }
}

/**
 * Per-TURN Codex token usage off a `token_count` event's `info.last_token_usage` (the
 * delta for the turn just completed, as opposed to `codexUsage`'s cumulative total).
 * `input_tokens` is the total prompt count for the turn and already INCLUDES the cached
 * share (OpenAI semantics), so `cachedInputTokens` is surfaced as the subset it is —
 * NOT added on top (adding it would double-count every cached token).
 */
function codexLastTurnUsage(event: Record<string, unknown>):
  | {
      inputTokens: number
      cachedInputTokens: number
      outputTokens: number
    }
  | undefined {
  const info = isObject(event.info) ? (event.info as Record<string, unknown>) : undefined
  const raw = info && isObject(info.last_token_usage) ? info.last_token_usage : undefined
  if (!isObject(raw)) return undefined
  const input = numberOf(raw.input_tokens)
  const cached = numberOf(raw.cached_input_tokens)
  const output = numberOf(raw.output_tokens)
  if (input === 0 && output === 0) return undefined
  return { inputTokens: input, cachedInputTokens: cached, outputTokens: output }
}

/** Dispatch to the configured subscription harness runner. */
export function runSubscriptionHarness(
  harness: SubscriptionHarness,
  opts: SubscriptionRunOptions,
): Promise<PiRunOutcome> {
  return harness === 'claude-code' ? runClaudeCode(opts) : runCodex(opts)
}
