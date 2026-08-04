import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { claudeAssistantContent, isObject, numberOf, redactBody } from './claude-stream.js'
import { createClaudeRunTelemetry, subagentDispatchId } from './claude-call-aggregator.js'
import {
  ToolCallTracker,
  type TrackedToolCall,
  recordClaudeToolResults,
} from './tool-trajectory.js'
import type { Logger } from './logger.js'
import {
  createCallMetricPublisher,
  publishCallMetric,
  type CallMetricPublisher,
  type HarnessCallMetric,
  type PiRunOutcome,
  type PiRunStats,
  type TodoProgress,
  type ToolSpan,
} from './pi.js'
import {
  claudeAllowedToolPatterns,
  codexMcpConfigToml,
  mcpServerSecretValues,
  writeClaudeMcpConfig,
  type McpServerSpec,
  type SkillSpec,
} from './agent-capabilities.js'
import { ProgressGuard, type ProgressGuardLimits } from './progress-guard.js'
import { killChildProcess, spawnDetached } from './process.js'
import { describeProcessExit } from './process-exit.js'
import { redact, registerKnownSecrets, secretsToRedact } from './redact.js'
import { createSliceTracker, startSubagentWatcher, type SliceReview } from './subagents.js'
import {
  createTaskPlanTracker,
  mergeProgress,
  normalizeStatus,
  pickProgress,
  toProgress,
  todosToProgress,
} from './progress.js'
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
  /** The vendor's own model id (what the agent CLI is invoked with), never a catalog id. */
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
   * The skills to install natively before launch. The claude-code runner writes each to
   * `CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md` (+ resource files) so the CLI loads them — but ONLY
   * when it owns an isolated config home, i.e. NOT under `ambientAuth`. The codex runner ignores
   * them outright. Every case that skips the native install reads the checkout's
   * `.cat-context/skill/<name>/`, materialised by the caller.
   */
  skills?: SkillSpec[]
  /**
   * Tool servers (MCP) to wire into the CLI for this run. Written to a PER-RUN config the CLI is
   * pointed at — never a HOME-global one, which a second concurrent job would clobber and which
   * carries this job's credentials. Absent ⇒ the CLI's built-in tools only.
   */
  mcpServers?: McpServerSpec[]
  /**
   * Extra environment for the CLI child, scoped to this job (the tester's secrets, a
   * private-registry npmrc pointer). Merged over the inherited `process.env` at spawn, so the
   * agent and its shell tools see them without the harness mutating its OWN environment — which
   * is shared by every concurrent job under the native host-process transport. See
   * `RunOptions.agentEnv`.
   */
  extraEnv?: Record<string, string>
  /** Aborting this kills the CLI (the job's inactivity/max-duration watchdog). */
  signal?: AbortSignal
  /**
   * Fully-resolved no-progress guard limits (env defaults merged loosen-only with the kind's
   * tuning + any complexity-scaled allowance). When set, the claude-code runner runs the SAME
   * {@link ProgressGuard} as Pi over the CLI's tool stream and kills a run that has plainly
   * stopped making progress (no-edit probing, error-retry loop, web rabbit-hole) rather than
   * letting it burn the whole wall-clock budget. Omitted ⇒ the guard is disabled for this run
   * (only the external watchdog bounds it), preserving the pre-guard behaviour.
   */
  guardLimits?: ProgressGuardLimits
  /** Whether this run is expected to edit files (false for assess-only runs); gates the no-edit bound. */
  expectsEdits?: boolean
  /** Called on every chunk of CLI output, so the watchdog sees the agent is alive. */
  onActivity?: () => void
  /** Called with the latest subtask counts each time the CLI updates its todo/plan list. */
  onProgress?: (progress: TodoProgress) => void
  /**
   * Called once per completed tool call with a {@link ToolSpan}: the run's TRAJECTORY. The CLI's
   * tool loop is internal to the CLI and never touches our proxy, so its own event stream is the
   * only place these exist — without this hook a subscription-harness run's account of what it
   * DID dies with the container.
   */
  onSpan?: (span: ToolSpan) => void
  /**
   * Called with the FULL set of per-slice reviews each time one lands, so the backend can persist
   * a parallel review's completed work as it happens instead of only from the terminal result.
   * A whole value rather than a delta: the set only grows and losing a finished slice's report to
   * a dropped poll would defeat the point (see `SliceTracker.sliceReviews`).
   */
  onSliceReviews?: (reviews: SliceReview[]) => void
  /**
   * Called with each per-call telemetry row as the CLI stream yields it, so the backend can
   * record the run's model calls WHILE it runs instead of only from its terminal result. The
   * same row still rides the result, so a lost poll response costs nothing.
   */
  onCallMetric?: (call: HarnessCallMetric) => void
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
  onEvent: (event: Record<string, unknown>, meta?: { final?: boolean }) => void,
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

    // `final` marks the at-close flush of a trailing unterminated line: the CLI has already
    // exited, so an observer must not act on that record in a way that KILLS the run (mirrors
    // `runPi`'s `runGuard = false` flush — without it, a guard tripping on the last buffered
    // record could turn a clean exit into a spurious "no progress" failure). The record's
    // progress/telemetry signal is still delivered; only kill decisions are suppressed.
    const processLine = (line: string, final = false): void => {
      if (!line.startsWith('{')) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      try {
        onEvent(event, { final })
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
    child.on('close', (code, signal) => {
      opts.signal?.removeEventListener('abort', onAbort)
      const stderrTail = redact(stderr, secrets).slice(-700)
      if (lineBuffer.trim()) processLine(lineBuffer.trim(), true)
      if (aborted) {
        // Carry the tail on the rejection so a caller that REPLACES this generic message with a
        // more specific cause (the no-progress guard's diagnostic) can still append it — the
        // stderr is often the only evidence of what the CLI was doing when it was killed.
        reject(Object.assign(new Error('agent run aborted by watchdog'), { stderrTail }))
        return
      }
      if (code !== 0) {
        reject(new CliExitFailure({ command, exitCode: code, signal, stderrTail }))
        return
      }
      resolve({ stderrTail })
    })
  })
}

/**
 * A CLI subprocess that ended badly — it exited non-zero, or a signal killed it.
 *
 * Its own class (rather than a formatted string) because the message is not final at throw time:
 * the caller folds in the CLI's terminal report before it surfaces (see {@link withAgentReport}),
 * and rebuilding from parts beats patching a rendered sentence. Distinct from the watchdog-abort
 * rejection above, which owns its own diagnostic and must keep it.
 */
class CliExitFailure extends Error {
  readonly parts: CliExit
  /**
   * Also exposed flat, matching the watchdog-abort rejection's shape: the guard-trip branch
   * reads `stderrTail` off whatever it caught to append to its own replacement message.
   */
  readonly stderrTail: string
  constructor(parts: CliExit, report = '') {
    super(cliExitMessage(parts, report))
    this.name = 'CliExitFailure'
    this.parts = parts
    this.stderrTail = parts.stderrTail
  }
}

interface CliExit {
  command: string
  /** The exit code, or `null` when a signal killed the CLI instead. */
  exitCode: number | null
  signal: NodeJS.Signals | null
  stderrTail: string
}

/**
 * One message shape for a CLI that ended badly, with or without a report to add.
 *
 * How it ended is rendered through {@link describeProcessExit}, the shared vocabulary every
 * process-reporting transport uses, so an externally-killed container job (an OOM kill, a
 * `docker stop` racing teardown) reads differently from the CLI's own failure exit.
 */
function cliExitMessage(exit: CliExit, report: string): string {
  const how = describeProcessExit(exit.exitCode, exit.signal)
  const suffix = report ? ` Agent's last report: ${report}` : ''
  return `${exit.command} ${how}: ${exit.stderrTail || '(no stderr output)'}${suffix}`
}

/**
 * Re-throw a bad CLI exit with the CLI's own account of how the run ended folded in.
 *
 * Both agent CLIs report a terminal failure on STDOUT, inside their event stream (Claude Code's
 * `result` event, Codex's last agent message) — never on stderr. So a run the upstream API kept
 * refusing exits non-zero with an EMPTY stderr tail, and the harness surfaces `claude exited with
 * code 1:` and nothing else, while the reason it collected sits in a local variable only the
 * SUCCESS path returns. That failure is indistinguishable from a crash, and the operator has no
 * next step. Nothing else in the run records it: the CLI's session transcript dies with the
 * per-run config home, and a local-mode container is removed the moment the job settles.
 *
 * Anything that is not a bad-exit rejection passes through untouched — a watchdog abort and a
 * tripped progress guard carry more specific diagnostics already.
 */
function withAgentReport(err: unknown, report: string, secrets: string[]): unknown {
  if (!(err instanceof CliExitFailure)) return err
  const folded = capReport(redact(report, secrets).trim())
  return folded ? new CliExitFailure(err.parts, folded) : err
}

/** How much of the agent's terminal report the failure message carries. */
const MAX_AGENT_REPORT_CHARS = 700

/**
 * Bound the agent's terminal report, keeping its HEAD — the opposite bias from the stderr tail
 * beside it, and deliberately so. A stderr tail is a log: the cause is whatever it ended on. A
 * report is a written statement, and its opening is where the answer lives — the failure
 * `subtype` {@link claudeResultReport} prepends, or the first line of Codex's last agent message.
 * Tail-slicing it drops exactly the classification the fold exists to surface.
 *
 * A cut is marked, because a report that merely stops reads like an agent that trailed off.
 */
function capReport(report: string): string {
  if (report.length <= MAX_AGENT_REPORT_CHARS) return report
  return `${report.slice(0, MAX_AGENT_REPORT_CHARS)}… (report truncated)`
}

/**
 * The CLI's own account of how the run ended, read off its terminal `result` event: the failure
 * `subtype` it names (`error_during_execution`, `error_max_turns`, …) joined to whatever text it
 * printed. A headless `-p` run reports an upstream API refusal HERE — on stdout, as JSON — and
 * nowhere else, so this is what a bad exit has to carry. A clean result yields just its text.
 */
function claudeResultReport(event: Record<string, unknown>): string {
  const subtype = typeof event.subtype === 'string' ? event.subtype : ''
  const text = typeof event.result === 'string' ? event.result.trim() : ''
  const failed = event.is_error === true || (subtype !== '' && subtype !== 'success')
  return failed ? [subtype || 'error', text].filter(Boolean).join(': ') : text
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
async function writeNativeSkill(skillsRoot: string, skill: SkillSpec): Promise<void> {
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

/**
 * Prepare the Claude Code CLI's MCP wiring for one run: write the servers to a PER-RUN config and
 * return the argv that points the CLI at it, plus the cleanup for a directory we had to mint.
 *
 * Two decisions live here. `--strict-mcp-config` makes that file the ONLY source of servers, so an
 * ambient run on a developer's own machine can never silently hand the agent their personal ones.
 * And `--allowedTools` is passed ONLY when a server actually narrows its tools — an allow-list is
 * whole-session, not MCP-scoped, so `claudeAllowedToolPatterns` re-grants the CLI's built-in
 * file/bash tools in the same list; see it for why that holds whichever way the run's permission
 * mode treats an allow-list.
 *
 * The config carries this job's resolved credentials, so it goes in the isolated config home when
 * we own one and a throwaway per-JOB directory otherwise — never the checkout (it would land in a
 * commit) and never a shared HOME path (a concurrent job would clobber it).
 */
async function setUpClaudeMcp(
  servers: McpServerSpec[] | undefined,
  configHome: string | undefined,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const noop = { args: [], cleanup: async () => {} }
  if (!servers?.length) return noop
  // Before anything can spawn: a failing MCP server echoes its own argv/headers into stderr, and
  // that tail is carried onto the step's diagnostics.
  registerKnownSecrets(mcpServerSecretValues(servers))
  const home = configHome ?? (await mkdtemp(join(tmpdir(), 'cf-claude-mcp-')))
  const owned = home === configHome ? undefined : home
  const cleanup = async (): Promise<void> => {
    if (owned) await rm(owned, { recursive: true, force: true }).catch(() => {})
  }
  const configPath = await writeClaudeMcpConfig(home, servers)
  if (!configPath) return { args: [], cleanup }
  const allowedTools = claudeAllowedToolPatterns(servers)
  return {
    args: [
      '--mcp-config',
      configPath,
      '--strict-mcp-config',
      ...(allowedTools?.length ? ['--allowedTools', allowedTools.join(',')] : []),
    ],
    cleanup,
  }
}

/**
 * No-progress guard on the CLI's own tool stream — the claude-code analogue of runPi's guard,
 * which cannot see the CLI's internal turns. The caller remembers each `tool_use` id's name off
 * the assistant turn (`rememberTool`) and hands the following user turn's content to `feedGuard`,
 * which pairs each `tool_result`'s `is_error` with that name. The FIRST reason trips it: the
 * diagnostic is recorded (readable via `reason()`, which the catch surfaces over the generic abort
 * message) and `guardAbort` fires — folded into streamCli's signal so a tripped guard kills the CLI
 * the same way the external watchdog does. Disabled when the caller supplies no limits (only the
 * external watchdog then bounds the run).
 *
 * Split out of {@link runClaudeCode} for the per-function line budget.
 */
function createClaudeProgressGuard(opts: SubscriptionRunOptions): {
  rememberTool: (id: string, name: string) => void
  feedGuard: (content: unknown[]) => void
  guardAbort: AbortController
  reason: () => string | undefined
} {
  const guard = opts.guardLimits
    ? new ProgressGuard(opts.guardLimits, opts.expectsEdits ?? true)
    : undefined
  const toolNames = new Map<string, string>()
  const guardAbort = new AbortController()
  let guardReason: string | undefined

  const feedGuard = (content: unknown[]): void => {
    if (!guard || guardReason) return
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_result') continue
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
      const name = id ? toolNames.get(id) : undefined
      if (id) toolNames.delete(id)
      if (!name) continue
      const reason = guard.observeSignal({ name, isError: block.is_error === true })
      if (reason) {
        guardReason = reason
        guardAbort.abort()
        return
      }
    }
  }

  return {
    rememberTool: (id, name) => toolNames.set(id, name),
    feedGuard,
    guardAbort,
    reason: () => guardReason,
  }
}

/**
 * The run's TRAJECTORY, on the claude-code stream: each `tool_use` block paired with the
 * `tool_result` that answers it on the following user turn, numbered and captured (scrubbed +
 * capped). The CLI's stream is the only place this loop is visible at all — its tool calls never
 * touch our proxy — so without this a subscription-harness run's account of what it DID dies with
 * the container.
 *
 * Both halves are no-ops when the caller wants no spans, so a driver that only needs the run's
 * output never pays to serialise a body nothing will read. Split out of {@link runClaudeCode} for
 * the per-function line budget, like {@link createClaudeProgressGuard}.
 */
function createClaudeToolTrajectory(
  opts: SubscriptionRunOptions,
  secrets: readonly string[],
): {
  onToolUse: (id: string, name: string, input: unknown) => void
  onToolResults: (content: unknown[]) => void
} {
  if (!opts.onSpan) return { onToolUse: () => {}, onToolResults: () => {} }
  const onSpan = opts.onSpan
  const tracker = new ToolCallTracker(secrets)
  return {
    onToolUse: (id, name, input) => tracker.started(id, name, input),
    onToolResults: (content) =>
      recordClaudeToolResults(tracker, content, (call: TrackedToolCall) =>
        onSpan({ ...call, bodies: 'stored' }),
      ),
  }
}

export async function runClaudeCode(opts: SubscriptionRunOptions): Promise<PiRunOutcome> {
  const stats: PiRunStats = { toolCalls: 0, assistantChars: 0 }
  let summary = ''
  /** The CLI's own account of how the run ended — see {@link claudeResultReport}. */
  let terminalReport = ''
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
  // stream. `--output-format stream-json --verbose` emits a near-verbatim Anthropic
  // Messages envelope per response CONTENT BLOCK (not per call), so the aggregator below
  // folds the envelopes sharing a `message.id` back into one call and buffers that call's
  // `user` tool_result turns — together the growing prompt transcript, in the shape the
  // model was actually sent. We seed it with the inputs the harness supplies (they never
  // appear in the stream): the system + first user message when the prompt rides argv, or
  // a single folded user turn when it doesn't — so the reconstruction never shows a system
  // turn that was never sent. Bodies are credential-scrubbed (they can echo the leased token).
  const secrets = opts.subscriptionToken ? secretsToRedact(opts.subscriptionToken) : []
  const calls: HarnessCallMetric[] = []
  // Streams each call as the CLI yields it, EXCEPT one whose tokens `attributeCumulativeUsage`
  // may still rewrite below (a published call must be final — see the publisher).
  const publisher = createCallMetricPublisher(calls, opts.onCallMetric)
  // `watcherOwnsSubagents` tracks the `startSubagentWatcher` wiring below: it is started only when
  // the CLI has an isolated config home to watch, which an `ambientAuth` run does not have. The
  // telemetry routes the CLI's tagged subagent turns accordingly — see `createClaudeRunTelemetry`.
  const telemetry = createClaudeRunTelemetry({
    seed: folded
      ? [{ role: 'user', content: prompt }]
      : [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userPrompt },
        ],
    secrets,
    watcherOwnsSubagents: !opts.ambientAuth,
    publish: (metric) => publisher.publish(metric),
  })

  // ADR 0026 D2.1 + ADR 0027 Defect B: surface live slice progress from the two views the run
  // produces of the SAME slicing. The parent's subagent dispatches + their terminal tool_results
  // appear on this stream (as do the subagents' own intermediate turns, tagged with the dispatch
  // that spawned them — see `isSubagentEvent`), so `sliceTracker` knows which slices are in flight
  // and which have returned; the parent's own plan (tracked by `planTracker` + `lastTodo`) is the
  // only place a not-yet-dispatched slice is named at all.
  //
  // The plan arrives in one of two tool vocabularies depending on the bundled CLI build:
  // `TodoWrite` (whole-list snapshots, tracked in `lastTodo`) or the incremental
  // `TaskCreate`/`TaskUpdate` pair (tracked by `planTracker`, which needs the tool RESULTS too
  // because the task id is minted there). Both are read, and `pickProgress` resolves that
  // either/or; the plan then MERGES with the dispatch view (`mergeProgress`) rather than
  // competing with it — picking the further-along view collapsed the list to the dispatched
  // slices alone the moment the first subagent returned. See ./progress.ts.
  const sliceTracker = createSliceTracker(secrets)
  const planTracker = createTaskPlanTracker()
  let lastTodo: TodoProgress | undefined
  const emitProgress = (): void => {
    if (!opts.onProgress) return
    const progress = mergeProgress(
      pickProgress(lastTodo, planTracker.progress()),
      sliceTracker.progress(),
    )
    if (progress) opts.onProgress(progress)
  }
  // Publish the per-slice reviews the tracker has captured. Separate from `emitProgress` because
  // the two answer different questions and have different lifetimes: progress is a disposable
  // count the UI renders, while these carry the slices' actual review WORK and are persisted so a
  // run that dies before its aggregation can be resumed from them.
  const emitSliceReviews = (): void => {
    if (!opts.onSliceReviews) return
    const reviews = sliceTracker.sliceReviews()
    if (reviews.length > 0) opts.onSliceReviews(reviews)
  }

  // No-progress guard on the CLI's own tool stream — the claude-code analogue of runPi's guard,
  // absent on this path until now. Claude Code reports a tool CALL (its name) on the `assistant`
  // turn and that call's RESULT (`is_error`) on the following `user` turn, so correlate them by
  // `tool_use` id to feed the guard a {name,isError} signal. A tripped guard aborts the CLI via
  // `guardAbort` (folded into streamCli's signal below) and the run then fails with its
  // diagnostic. Disabled when the caller supplies no limits (only the external watchdog bounds it).
  const progressGuard = createClaudeProgressGuard(opts)
  const { rememberTool, feedGuard, guardAbort } = progressGuard
  const trajectory = createClaudeToolTrajectory(opts, secrets)

  const onEvent = (event: Record<string, unknown>, meta?: { final?: boolean }): void => {
    const type = event.type
    // A subagent's turns ride the parent's stdout tagged with the dispatch that spawned them;
    // `telemetry` routes them off the parent's chain (and decides who bills them). Progress, slice
    // tracking, the guard and `stats` below deliberately see EVERY event: a subagent grinding on
    // errors should trip the guard exactly as the parent would, and whether the agent acted at all
    // does not depend on which channel billed it.
    const dispatchId = subagentDispatchId(event)
    if (type === 'assistant' && isObject(event.message)) {
      const message = event.message as Record<string, unknown>
      const content = Array.isArray(message.content) ? message.content : []
      const { text, toolUses } = claudeAssistantContent(content)
      stats.assistantChars += text.length
      stats.toolCalls += toolUses
      telemetry.onAssistant(dispatchId, message)
      for (const block of content) {
        if (!isObject(block) || block.type !== 'tool_use') continue
        // Remember each call's name against its id so the guard can pair it with the
        // `is_error` its `tool_result` carries on the next `user` turn.
        if (typeof block.id === 'string' && typeof block.name === 'string') {
          rememberTool(block.id, block.name)
          trajectory.onToolUse(block.id, block.name, block.input)
        }
        if (block.name === 'TodoWrite') {
          const progress = todosToProgress((block.input as Record<string, unknown>)?.todos)
          if (progress) lastTodo = progress
        }
      }
      sliceTracker.onAssistant(content)
      planTracker.onAssistant(content)
      emitProgress()
    } else if (type === 'user' && isObject(event.message)) {
      // tool_result blocks the harness fed back to the model — part of the next prompt.
      const content = (event.message as Record<string, unknown>).content
      if (Array.isArray(content)) {
        sliceTracker.onUser(content)
        planTracker.onUser(content)
        emitProgress()
        // A slice's report lands on exactly this turn, so publish here: waiting for the next
        // progress tick would risk the job dying with the report captured but never surfaced.
        emitSliceReviews()
        // Not on the at-close flush: the CLI has already exited, so tripping the guard there
        // would kill nothing and only convert a clean exit into a spurious failure.
        if (!meta?.final) feedGuard(content)
        // The trajectory's other half — fed on the FINAL flush too, unlike the guard, since a
        // CLI that has exited is exactly when the last calls' results matter.
        trajectory.onToolResults(content)
        telemetry.onToolResult(dispatchId, content)
      }
    } else if (type === 'result') {
      if (typeof event.result === 'string') summary = event.result
      usage = claudeUsage(event.usage) ?? usage
      terminalReport = claudeResultReport(event) || terminalReport
    }
  }

  const home = await openClaudeRunHome(opts)
  const { configHome } = home

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
        ...(opts.onCallMetric ? { onCallMetric: opts.onCallMetric } : {}),
        ...(opts.log ? { log: opts.log } : {}),
      })
    : undefined

  // Fold the guard's abort into the run signal so a tripped guard kills the CLI the same way the
  // external watchdog does; `guardReason` (set above) distinguishes the two at the catch below.
  const runSignal = opts.signal
    ? AbortSignal.any([opts.signal, guardAbort.signal])
    : guardAbort.signal

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
          ...home.mcpArgs,
          ...appendArgs,
        ],
      },
      prompt,
      { ...opts, signal: runSignal },
      home.env,
      opts.subscriptionToken ? secretsToRedact(opts.subscriptionToken) : [],
      onEvent,
    )

    // The stream has ended, so the last call has no successor envelope to complete it.
    telemetry.flush()
    return await assembleClaudeOutcome({
      summary,
      stats,
      stderrTail,
      calls,
      publisher,
      usage,
      subagents,
      expectSubagentCalls: telemetry.expectsWatcherCalls(),
      ...(opts.log ? { log: opts.log } : {}),
    })
  } catch (err) {
    // The stream ended abnormally (guard trip, watchdog kill, CLI crash). Complete the call in
    // flight anyway, and release whatever the publisher was withholding: a killed run never
    // returns an outcome, so the live channel is the ONLY record of what it spent, and dropping
    // its last turn is what the streaming exists to avoid.
    telemetry.flush()
    publisher.flush()
    // A tripped no-progress guard aborted the CLI; streamCli rejects with its generic abort
    // message, so replace it with the guard's actionable diagnostic — carrying the stderr tail it
    // attached, since that is usually the only evidence of what the CLI was doing when it was
    // killed. The leading clauses are byte-for-byte the shape `runPi` fails with; a terminal
    // report is appended after them when the CLI managed to emit one before it was killed, which
    // is uncommon but is the same evidence a bad exit now carries — a guard trip is no reason to
    // discard it.
    const guardReason = progressGuard.reason()
    if (guardReason) {
      const tail = (err as { stderrTail?: string } | undefined)?.stderrTail
      const report = capReport(redact(terminalReport, secrets).trim())
      throw new Error(
        [
          guardReason,
          tail ? `Agent stderr: ${tail}` : '',
          report ? `Agent's last report: ${report}` : '',
        ]
          .filter(Boolean)
          .join(' '),
      )
    }
    throw withAgentReport(err, terminalReport, secrets)
  } finally {
    await subagents?.stop()
    await home.dispose()
  }
}

/**
 * The isolated, per-run home the `claude` CLI runs against: a temp config dir OUTSIDE the cloned
 * checkout, pre-seeded past the first-launch prompts, carrying the run's native skills and MCP
 * config, plus the child env pointing the CLI at it. {@link ClaudeRunHome.dispose} is the other
 * half of the same concern — the leased credential must never outlive the run — so acquisition
 * and teardown are defined together rather than split across a `finally` forty lines away.
 *
 * Ambient (native) mode has NO home: the developer's installed CLI uses its own `~/.claude`
 * login, so nothing is created, nothing is pre-seeded, and `dispose` only clears the MCP config.
 */
interface ClaudeRunHome {
  /** The per-run config dir; `undefined` in ambient mode (the developer's own login is used). */
  configHome: string | undefined
  /** The CLI argv selecting the run's tool servers; empty when it has none. */
  mcpArgs: string[]
  /** The child-process env (see {@link buildClaudeEnv}). */
  env: Record<string, string>
  dispose: () => Promise<void>
}

async function openClaudeRunHome(opts: SubscriptionRunOptions): Promise<ClaudeRunHome> {
  // Native (ambient) mode: run the developer's installed `claude` with its OWN login —
  // no isolated config home, no injected credential, no onboarding pre-seed. Otherwise,
  // Claude Code persists user config/credentials under its config dir; point that at an
  // isolated, per-run temp dir OUTSIDE the cloned checkout (`opts.cwd`). Otherwise the
  // agents that finish with `git add -A` (blueprint/requirements/bootstrap) could stage a
  // stray `.claude/` directory — and any cached credential in it — into the pushed branch.
  // Mirrors the Codex CODEX_HOME isolation below; removed by `dispose`.
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

  // Skills: install each as a native skill under the config dir's `skills/<name>/` so the CLI
  // discovers and can invoke it. ONLY into the isolated per-run config home — never the
  // developer's own `~/.claude` (ambient/native mode), where it would persist in their personal
  // setup after the run and two concurrent jobs carrying same-named skills would clobber each
  // other. An ambient run reads the skills from the checkout instead (`.cat-context/skill/<name>/`,
  // materialised by the caller). Best-effort: a write failure must not wedge the run — the prompt
  // still names the skills.
  if (configHome) {
    for (const skill of opts.skills ?? []) {
      await writeNativeSkill(join(configHome, 'skills'), skill).catch(() => {})
    }
  }

  // Tool servers (MCP): the CLI is pointed at a per-run config rather than discovering an ambient
  // one. See `setUpClaudeMcp` for why that matters and what has to be cleaned up afterwards.
  const mcp = await setUpClaudeMcp(opts.mcpServers, configHome)

  return {
    configHome,
    mcpArgs: mcp.args,
    env: buildClaudeEnv(opts, configHome),
    dispose: async () => {
      // The ambient-mode MCP config dir (credential-bearing) never outlives the run.
      await mcp.cleanup()
      if (!configHome) return
      // Lift the CLI session transcripts (`projects/`) out for short-lived retention BEFORE the
      // home is deleted — the credential lives at the home root, never in `projects/`, so this
      // keeps the debugging artifact without leaking the token. Best-effort; never throws.
      await retainSessionTranscripts(configHome, ['projects'], {
        label: 'claude-code',
        ...(opts.log ? { log: opts.log } : {}),
      })
      // Never leave the config dir (and any cached credential) on disk past the run.
      await rm(configHome, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/**
 * Build the child-process env for the `claude` CLI: an isolated config home plus subscription
 * auth (Anthropic OAuth token, or an Anthropic-compatible base URL + auth token for a
 * non-Anthropic Claude-Code vendor like GLM/Kimi/DeepSeek), or an empty env in ambient mode
 * (the developer's own logged-in `~/.claude` is used). Extracted from {@link runClaudeCode} to
 * keep its cyclomatic complexity down; behaviour is a straight move of the original expression.
 */
function buildClaudeEnv(
  opts: SubscriptionRunOptions,
  configHome: string | undefined,
): Record<string, string> {
  // The job-scoped env rides along in BOTH modes; the credential/config vars below are what
  // ambient mode drops (the developer's own logged-in `~/.claude` is used instead).
  if (opts.ambientAuth) return { ...opts.extraEnv }
  return {
    ...opts.extraEnv,
    CLAUDE_CONFIG_DIR: configHome!,
    ...(opts.subscriptionBaseUrl
      ? {
          ANTHROPIC_BASE_URL: opts.subscriptionBaseUrl,
          ANTHROPIC_AUTH_TOKEN: opts.subscriptionToken!,
        }
      : { CLAUDE_CODE_OAUTH_TOKEN: opts.subscriptionToken! }),
  }
}

/**
 * Merge the parent-loop telemetry with the subagents' out-of-band usage + per-call metrics into
 * the run outcome. INVARIANT (do not "fix" this into a double count): the run total is the parent
 * usage PLUS the subagent usage because the two are disjoint sources — the parent `usage` (the
 * terminal `result` event's cumulative) covers ONLY the parent loop, and the subagent tokens live
 * exclusively in the per-session `subagents/*.jsonl` transcripts the watcher reads. Extracted from
 * {@link runClaudeCode} verbatim to keep its cyclomatic complexity down.
 *
 * The invariant is about the aggregate `usage` only. `calls` was NEVER disjoint from the watcher's
 * on its own: the CLI streams a subagent's turns onto the parent's stdout as well, so the parent
 * loop's telemetry must filter them (`subagentDispatchId`) for this concatenation to hold.
 */
async function assembleClaudeOutcome(args: {
  summary: string
  stats: PiRunStats
  stderrTail: string
  calls: HarnessCallMetric[]
  /** The live-stream publisher, flushed once attribution has finalised the calls' tokens. */
  publisher: CallMetricPublisher
  usage: { inputTokens: number; outputTokens: number } | undefined
  subagents: ReturnType<typeof startSubagentWatcher> | undefined
  /**
   * The parent stream carried subagent turns AND the watcher was the channel meant to record them.
   * A watcher that then yields nothing means the run lost its subagent rows entirely — the CLI's
   * transcript layout is not a stable contract (ADR 0027 Defect A moved it once already), so say
   * so rather than under-reporting the spend in silence.
   */
  expectSubagentCalls: boolean
  log?: Logger
}): Promise<PiRunOutcome> {
  const { summary, stats, stderrTail, calls, publisher, usage, subagents } = args
  // The parent's cumulative-usage fallback applies to the PARENT calls only (before the
  // subagent calls, which carry their own per-turn tokens, are concatenated).
  attributeCumulativeUsage(calls, usage)
  // The withheld calls are final only NOW, so stream them: the completion poll drains them
  // alongside the result, and the backend records the attributed numbers rather than the zeros
  // they carried while the run was in flight.
  publisher.flush()
  // Final drain of any subagent transcript writes that landed after the last poll, then
  // fold the subagents' usage + per-call telemetry into the run's outcome.
  await subagents?.stop()
  const subUsage = subagents?.usage() ?? { inputTokens: 0, outputTokens: 0 }
  const subCalls = subagents?.calls() ?? []
  if (args.expectSubagentCalls && !subCalls.length) {
    args.log?.warn(
      'subagent turns were streamed but the transcript watcher captured no calls; their token ' +
        'spend is missing from this run’s telemetry (check the CLI’s subagents/*.jsonl layout)',
    )
  }
  const mergedCalls = [...calls, ...subCalls]
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
  // The running CUMULATIVE total, kept in its reported (inclusive) form plus the cached share
  // it contains. `PiRunOutcome.usage` needs the inclusive figure — it is the key-rotation
  // weight — while the fallback call metric below needs the split, so both are derived from
  // this one value rather than one being reconstructed from the other.
  let cumulative: CodexCumulativeUsage | undefined

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
    // Tool servers (MCP) ride the SAME per-run config.toml, so they are scoped to this job and
    // torn down with the home. Under AMBIENT auth there is no per-run home — and writing servers
    // into the developer's own `~/.codex/config.toml` would outlive the run and race a concurrent
    // job — so an ambient codex run gets no MCP servers; the backend states them as unavailable
    // the same way it does for a harness with no MCP client at all.
    // Registered before the CLI starts, for the same reason the claude path does it: a server that
    // fails to launch puts its own command line into the stderr tail we keep.
    if (opts.mcpServers?.length) registerKnownSecrets(mcpServerSecretValues(opts.mcpServers))
    const mcpToml = opts.mcpServers?.length ? codexMcpConfigToml(opts.mcpServers) : ''
    await writeFile(
      join(codexHome, 'config.toml'),
      `cli_auth_credentials_store = "file"\n${mcpToml ? `\n${mcpToml}` : ''}`,
      { encoding: 'utf8', mode: 0o600 },
    )
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
    if (turnUsage) cumulative = turnUsage
    // A `token_count` event closes a model turn: pair its per-turn usage with the
    // assistant text seen since the previous turn as one telemetry call.
    const perTurn = codexLastTurnUsage(event)
    if (perTurn) {
      publishCallMetric(
        calls,
        {
          model: opts.model,
          promptText: redactBody(JSON.stringify(messages), secrets),
          messageCount: messages.length,
          responseText: redactBody(pendingText, secrets),
          reasoningText: '',
          inputTokens: perTurn.inputTokens,
          cacheReadTokens: perTurn.cacheReadTokens,
          cacheWriteTokens: perTurn.cacheWriteTokens,
          outputTokens: perTurn.outputTokens,
          finishReason: null,
        },
        opts.onCallMetric,
      )
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
      { ...opts.extraEnv, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
      opts.subscriptionToken ? secretsToRedact(opts.subscriptionToken) : [],
      onEvent,
    )

    // Fallback for a CLI/version that never emits per-turn `last_token_usage`: record a
    // single call from the cumulative total + final text so the run is still observable.
    // The cumulative total is inclusive of its cached share exactly as a per-turn one is, so
    // it is split the same way rather than being filed wholesale as fresh — which would report
    // a cache-heavy run as if nothing had been cached, the one reading this telemetry exists
    // to rule out.
    if (calls.length === 0 && (cumulative || summary)) {
      publishCallMetric(
        calls,
        {
          model: opts.model,
          promptText: redactBody(JSON.stringify(messages), secrets),
          messageCount: messages.length,
          responseText: redactBody(summary, secrets),
          reasoningText: '',
          inputTokens: Math.max(
            0,
            (cumulative?.inputTokens ?? 0) - (cumulative?.cachedInputTokens ?? 0),
          ),
          cacheReadTokens: cumulative?.cachedInputTokens ?? 0,
          // Codex reports no separate cache-WRITE class; 0 rather than guessed.
          cacheWriteTokens: 0,
          outputTokens: cumulative?.outputTokens ?? 0,
          finishReason: null,
        },
        opts.onCallMetric,
      )
    }
    // The outcome's usage is the key-rotation WEIGHT, so it keeps the inclusive input count.
    const usage = cumulative
      ? { inputTokens: cumulative.inputTokens, outputTokens: cumulative.outputTokens }
      : undefined
    return {
      summary,
      stats,
      stderrTail,
      ...(usage ? { usage } : {}),
      ...(calls.length ? { callMetrics: calls } : {}),
    }
  } catch (err) {
    // Codex surfaces its terminal failure the same way Claude Code does — in the stdout event
    // stream, not on stderr — so a bad exit carries the last thing the agent said.
    throw withAgentReport(err, summary, secrets)
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
  return toProgress(items)
}

/**
 * Codex's running cumulative usage, kept in the form the CLI reports it: `inputTokens` is the
 * TOTAL prompt count (OpenAI semantics) with `cachedInputTokens` a SUBSET already inside it,
 * never a bucket to add on top. The cached share is carried rather than discarded so a
 * consumer that needs the fresh figure can subtract it at the point of use, instead of the
 * only two readings of this number being "inclusive" and "lost".
 */
interface CodexCumulativeUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

/**
 * Best-effort: pull token usage out of a Codex usage event. Codex `exec --json`
 * reports a running CUMULATIVE total on `token_count` events under
 * `info.total_token_usage` (it also carries the per-turn `last_token_usage`); older /
 * other shapes put it on `usage` / `info.usage` directly. We read the cumulative
 * total when present so the caller can simply overwrite (not sum) — summing
 * cumulative totals across events would multiply-count. Checked most-likely first.
 */
function codexUsage(event: Record<string, unknown>): CodexCumulativeUsage | undefined {
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
  return {
    inputTokens: input,
    cachedInputTokens: numberOf(raw.cached_input_tokens),
    outputTokens: output,
  }
}

/**
 * Per-TURN Codex token usage off a `token_count` event's `info.last_token_usage` (the
 * delta for the turn just completed, as opposed to `codexUsage`'s cumulative total).
 *
 * OpenAI semantics: `input_tokens` is the turn's WHOLE prompt count and already INCLUDES
 * the cached share, so the fresh figure is the difference. Clamped at 0 because the two
 * counts come off the same event and a vendor inconsistency must not mint a negative token
 * count. Codex reports no separate cache-WRITE class, so that class is 0 here rather than
 * guessed.
 */
function codexLastTurnUsage(event: Record<string, unknown>):
  | {
      inputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
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
  return {
    inputTokens: Math.max(0, input - cached),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: output,
  }
}

/** Dispatch to the configured subscription harness runner. */
export function runSubscriptionHarness(
  harness: SubscriptionHarness,
  opts: SubscriptionRunOptions,
): Promise<PiRunOutcome> {
  return harness === 'claude-code' ? runClaudeCode(opts) : runCodex(opts)
}
