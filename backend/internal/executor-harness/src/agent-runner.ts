import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { claudeAssistantContent, isObject, numberOf, redactBody } from './claude-stream.js'
import { claudeUsage, unaccountedUsageCall } from './usage-attribution.js'
import {
  createClaudeRunTelemetry,
  subagentDispatchId,
  type ClaudeRunTelemetry,
} from './claude-call-aggregator.js'
import {
  ToolCallTracker,
  type TrackedToolCall,
  recordClaudeToolResults,
} from './tool-trajectory.js'
import { log, type Logger } from './logger.js'
import { NO_TOOL_WINDOW, type ToolProgressWindow } from './tool-silence.js'
import {
  publishCallMetric,
  type HarnessCallMetric,
  type PiRunOutcome,
  type TodoProgress,
  type ToolSpan,
} from './pi.js'
import type { PiRunStats } from './pi-reduction.js'
import {
  observeClaudeMcpInit,
  type McpServerSpec,
  type ObservedMcpServer,
  type SkillSpec,
} from './agent-capabilities.js'
import { openClaudeRunHome } from './claude-home.js'
import { codexImageGapNote, createCodexHome, disposeCodexHome } from './codex-home.js'
import { ProgressGuard, type ProgressGuardLimits } from './progress-guard.js'
import { BoundedTail, JsonlLineReader } from './jsonl-stream.js'
import { killChildProcess, spawnDetached } from './process.js'
import { abortReasonOf } from './failure.js'
import { describeProcessExit } from './process-exit.js'
import { redact, secretsToRedact } from './redact.js'
import { createSliceTracker, startSubagentWatcher, type SliceReview } from './subagents.js'
import {
  createTaskPlanTracker,
  mergeProgress,
  normalizeStatus,
  pickProgress,
  toProgress,
  todosToProgress,
} from './progress.js'
import { assertClaudeToolsCurrent, claudeCliArgs, CLAUDE_TOOL_SET } from './claude-cli.js'

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
   * CODEX ONLY: enable the CLI's built-in `image_gen` tool for this job, and redirect what it
   * writes into the checkout (see `codex-images.ts`).
   *
   * Opt-in per job rather than a property of the image, because the tool bills against the leased
   * ChatGPT plan at 3-5x an ordinary turn: every non-generating run would pay for a capability it
   * was never asked for. Set when the dispatch resolved a HARNESS-transport binary generator whose
   * `harness` is `codex`, which is the one signal that says this step exists to make pictures.
   *
   * A no-op under `ambientAuth`: there is no per-run `CODEX_HOME` to write a config into or
   * redirect, and the alternative — reconfiguring the developer's own `~/.codex` and staging into
   * their real output directory — is the HOME-global mutation this harness never makes. The
   * backend states the capability as unavailable there rather than half-enabling it.
   */
  generateImages?: boolean
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
   * Opens this stream's tool-silence window (see `RunOptions.beginToolWindow`), closed when the
   * CLI exits. Both subscription CLIs report tool activity — claude-code on the `tool_result`
   * turn that answers each call, codex on its tool/command/exec events — so a window either
   * opens is one the run can beat. It is deliberately NOT tied to {@link onSpan}: the trajectory
   * is an observability opt-in, and the codex stream produces none at all while still doing tool
   * work, which a span-keyed window would have read as a run making no progress.
   *
   * A caller with no tool loop (the inline one-shot completion) passes nothing; see the note at
   * `handleInline`.
   */
  beginToolWindow?: () => ToolProgressWindow
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
   * Called once with what the CLI reported about the tool servers it loaded, the moment it
   * announces its resolved session (see {@link observeClaudeMcpInit}).
   *
   * The one thing the backend's own dispatch record cannot answer: it knows why it WITHHELD a
   * tool, and this says a server it wired failed to start anyway. Reported even when every server
   * came up, because "observed, all healthy" and "this image observed nothing" are different
   * facts about a run and only the first one clears a wired server of suspicion.
   *
   * Whole-value latest-wins, not a delta — the CLI announces its session once, so a second call
   * would only ever be a re-announcement of the same set. A harness whose CLI reports nothing
   * (codex today) never calls this, which is what leaves the backend's record honestly empty
   * rather than claiming every server failed.
   */
  onToolServers?: (observed: ObservedMcpServer[]) => void
  /**
   * The per-job child logger (jobId/repo/branch correlation). Threaded so the retained
   * session-transcript path is logged for the run when the isolated config home is torn down.
   */
  log?: Logger
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

    // 8 KB is well over the 700 B tail anyone quotes below, and the CLI's stderr is diagnostic
    // noise rather than a product, so a bounded tail is all this ever needed to be.
    const stderr = new BoundedTail(8_000)
    let aborted = false

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

    // Bounded framing, shared with `runPi`: an unterminated record must not be able to grow
    // until parsing it stalls the loop the watchdogs and poll handlers run on (audit F6).
    const reader = new JsonlLineReader(processLine)

    const onAbort = (): void => {
      aborted = true
      killChild()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      opts.onActivity?.()
      reader.push(chunk.toString())
    })
    child.stderr.on('data', (chunk: Buffer) => {
      opts.onActivity?.()
      stderr.push(chunk.toString())
    })

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code, signal) => {
      opts.signal?.removeEventListener('abort', onAbort)
      const stderrTail = redact(stderr.toString(), secrets).slice(-700)
      reader.flush()
      // Surface an oversized record the reader refused to buffer ONCE (a count, not per line),
      // for the same reason `runPi` does: a dropped record costs this run its progress, its
      // trajectory and its per-call telemetry for that turn, and a silent loss reads exactly
      // like a CLI that never emitted it. Falls back to the module logger so the report cannot
      // depend on a caller having wired a per-job one.
      if (reader.droppedLines > 0) {
        ;(opts.log ?? log).warn('agent CLI: skipped oversized JSONL records', {
          command,
          oversizedLines: reader.droppedLines,
        })
      }
      if (aborted) {
        // SAY WHO ABORTED IT. Every abort reaches this branch, not just a watchdog's: the
        // shutdown handler aborts every running job (`harness shutting down (SIGTERM)`) and so
        // does a backend-requested stop. A watchdog kill is relabelled downstream from the
        // structured `killReason`, so hard-coding "aborted by watchdog" here was wrong for
        // exactly the aborts that have nothing else to say: a job killed because something
        // shut the harness down reported a watchdog that never fired, which is a wrong lead in
        // the one log an operator has. The reason rides `signal.reason` (see `runner.ts`'s
        // `entry.abort`), the way `settlePiRun` already reads it on the Pi path.
        //
        // Carry the tail on the rejection so a caller that REPLACES this message with a more
        // specific cause (the no-progress guard's diagnostic) can still append it: the stderr
        // is often the only evidence of what the CLI was doing when it was killed.
        reject(Object.assign(new Error(abortReasonOf(opts.signal)), { stderrTail }))
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
 * The LIVE publishers of a claude-code run: everything the stream has revealed so far that the
 * backend should see before the run ends, rather than only in its terminal result.
 *
 * They are grouped because they share one rule and differ on everything else. The rule: each
 * publishes a WHOLE current value (never a delta), so a dropped poll response costs nothing and
 * the caller may fire them as often as it likes. What differs is what is at stake — progress is a
 * disposable count the UI renders, while the slice reviews carry the slices' actual review WORK
 * and are the only thing a resume of a wedged review can be rebuilt from, which is why they are
 * published on the turn a slice lands rather than on the next progress tick.
 *
 * `lastTodo` is a GETTER because the event handler assigns it as the stream goes; taking the value
 * would freeze the plan at construction time.
 *
 * Split out of {@link runClaudeCode} for the per-function line budget.
 */
function createClaudeLivePublishers(deps: {
  opts: SubscriptionRunOptions
  planTracker: ReturnType<typeof createTaskPlanTracker>
  sliceTracker: ReturnType<typeof createSliceTracker>
  lastTodo: () => TodoProgress | undefined
}): { emitProgress: () => void; emitSliceReviews: () => void } {
  const { opts, planTracker, sliceTracker } = deps
  return {
    emitProgress: () => {
      if (!opts.onProgress) return
      const progress = mergeProgress(
        pickProgress(deps.lastTodo(), planTracker.progress()),
        sliceTracker.progress(),
      )
      if (progress) opts.onProgress(progress)
    },
    emitSliceReviews: () => {
      if (!opts.onSliceReviews) return
      const reviews = sliceTracker.sliceReviews()
      if (reviews.length > 0) opts.onSliceReviews(reviews)
    },
  }
}

/**
 * Publish the CLI's own startup report about the tool servers it loaded — the OBSERVED half of the
 * run's tool-server record.
 *
 * Handed every event because it is the one thing `runClaudeCode` reads that is neither a turn nor
 * a result: it arrives once, ahead of the first model call, and says whether the servers the
 * backend wired actually came up. {@link observeClaudeMcpInit} answers `undefined` for every other
 * event and for a run that wired none, so a server-less run reports nothing and the caller's
 * record stays honestly absent rather than empty.
 *
 * Split out of {@link runClaudeCode} for the per-function line budget.
 */
function reportToolServerStartup(
  event: Record<string, unknown>,
  onToolServers: ((observed: ObservedMcpServer[]) => void) | undefined,
): void {
  if (!onToolServers) return
  const observed = observeClaudeMcpInit(event)
  if (observed) onToolServers(observed)
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

/**
 * Open this run's tool-silence window, or the inert one when the caller wired no watchdog. One
 * definition so both runners resolve "is there a watchdog?" identically, and so neither carries
 * the optional-call noise at the point where it should simply have a window.
 */
function openToolWindow(opts: SubscriptionRunOptions): ToolProgressWindow {
  return opts.beginToolWindow ? opts.beginToolWindow() : NO_TOOL_WINDOW
}

/**
 * Whether a claude-code `user` turn carries a `tool_result` block, i.e. whether a tool call just
 * COMPLETED — the progress the tool-silence watchdog measures. Tested explicitly rather than
 * taken from "the model sent a user turn", which a plain follow-up prompt also is: a watchdog
 * reset handed out for work that did nothing is the same as no watchdog.
 */
function carriesToolResult(content: unknown[]): boolean {
  return content.some((block) => isObject(block) && block.type === 'tool_result')
}

/** One claude-code run's per-call telemetry: what was captured, and how it is settled. */
interface ClaudeCallCapture {
  /** Every captured call, terminal-result order — the parent's, the subagents', the remainder. */
  calls: HarnessCallMetric[]
  telemetry: ClaudeRunTelemetry
  /**
   * File whatever the parent's narrated turns did not account for, once its terminal cumulative
   * usage is known. A no-op when they add up. See {@link unaccountedUsageCall}.
   */
  settleUsage: (usage: { inputTokens: number; outputTokens: number } | undefined) => void
}

/**
 * Open the per-call telemetry capture for one claude-code run.
 *
 * It reconstructs the full per-call request/response bodies from the stream.
 * `--output-format stream-json --verbose` emits a near-verbatim Anthropic Messages envelope per
 * response CONTENT BLOCK (not per call), so the aggregator folds the envelopes sharing a
 * `message.id` back into one call and buffers that call's `user` tool_result turns — together the
 * growing prompt transcript, in the shape the model was actually sent. It is SEEDED with the inputs
 * the harness supplies (they never appear in the stream): the system + first user message when the
 * prompt rides argv, or a single folded user turn when it doesn't, so the reconstruction never shows
 * a system turn that was never sent. Bodies are credential-scrubbed (they can echo the leased token).
 *
 * The parent loop's calls are tracked SEPARATELY, by reference into the same list, because the
 * terminal `result` event's cumulative usage covers only the parent conversation. In `ambientAuth`
 * mode there is no transcript watcher, so the CLI's tagged subagent turns are captured here too and
 * `calls` holds both; reconciling against that mixed list is what once billed a subagent for the
 * parent's whole output shortfall.
 */
function openClaudeCallCapture(
  opts: SubscriptionRunOptions,
  stream: { prompt: string; folded: boolean; secrets: string[] },
): ClaudeCallCapture {
  const calls: HarnessCallMetric[] = []
  const parentCalls: HarnessCallMetric[] = []
  const publish = (metric: HarnessCallMetric): void =>
    publishCallMetric(calls, metric, opts.onCallMetric)
  // `watcherOwnsSubagents` tracks the `startSubagentWatcher` wiring in the caller: it is started
  // only when the CLI has an isolated config home to watch, which an `ambientAuth` run does not
  // have. The telemetry routes the CLI's tagged subagent turns accordingly — see
  // `createClaudeRunTelemetry`.
  const telemetry = createClaudeRunTelemetry({
    seed: stream.folded
      ? [{ role: 'user', content: stream.prompt }]
      : [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userPrompt },
        ],
    secrets: stream.secrets,
    watcherOwnsSubagents: !opts.ambientAuth,
    publish: (metric) => {
      parentCalls.push(metric)
      publish(metric)
    },
    publishSubagent: publish,
  })
  return {
    calls,
    telemetry,
    settleUsage: (usage) => {
      // Published like any other call so the live drain records it too, which is also what stamps
      // its `seq` and therefore its stable row id.
      const remainder = unaccountedUsageCall(parentCalls, usage)
      if (remainder) publish(remainder)
    },
  }
}

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

  // The built-in tools this run declares, named ONCE: the same list rides `--tools` and the
  // `--allowedTools` re-grant, which is additive rather than inert (see `claudeAllowedToolPatterns`).
  const tools = CLAUDE_TOOL_SET

  const secrets = opts.subscriptionToken ? secretsToRedact(opts.subscriptionToken) : []
  const capture = openClaudeCallCapture(opts, { prompt, folded, secrets })
  const telemetry = capture.telemetry

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
  const { emitProgress, emitSliceReviews } = createClaudeLivePublishers({
    opts,
    planTracker,
    sliceTracker,
    lastTodo: () => lastTodo,
  })

  // No-progress guard on the CLI's own tool stream — the claude-code analogue of runPi's guard,
  // absent on this path until now. Claude Code reports a tool CALL (its name) on the `assistant`
  // turn and that call's RESULT (`is_error`) on the following `user` turn, so correlate them by
  // `tool_use` id to feed the guard a {name,isError} signal. A tripped guard aborts the CLI via
  // `guardAbort` (folded into streamCli's signal below) and the run then fails with its
  // diagnostic. Disabled when the caller supplies no limits (only the external watchdog bounds it).
  const progressGuard = createClaudeProgressGuard(opts)
  const { rememberTool, feedGuard, guardAbort } = progressGuard
  const trajectory = createClaudeToolTrajectory(opts, secrets)
  // This stream's tool-silence window; opened just before the CLI starts and closed in the
  // `finally` below, so it can only ever be armed while the CLI it watches is running.
  let toolWindow: ToolProgressWindow = NO_TOOL_WINDOW

  const onEvent = (event: Record<string, unknown>, meta?: { final?: boolean }): void => {
    const type = event.type
    reportToolServerStartup(event, opts.onToolServers)
    // The same startup event answers what the CLI granted of what we asked for; a capability it
    // named no tool for is a silent capability loss otherwise (see `assertClaudeToolsCurrent`).
    assertClaudeToolsCurrent(event, tools, opts.log)
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
        if (carriesToolResult(content)) toolWindow.toolCompleted()
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

  const home = await openClaudeRunHome(opts, tools)
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

  // Opened around the CLI itself, not around this function: everything above is per-run setup
  // (the config home, the skills, the MCP config) which completes no tool calls by nature.
  toolWindow = openToolWindow(opts)
  try {
    const { stderrTail } = await streamCli(
      {
        command: 'claude',
        args: claudeCliArgs({ model: opts.model, tools, mcpArgs: home.mcpArgs, appendArgs }),
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
      capture,
      usage,
      subagents,
      expectSubagentCalls: telemetry.expectsWatcherCalls(),
      ...(opts.log ? { log: opts.log } : {}),
    })
  } catch (err) {
    // The stream ended abnormally (guard trip, watchdog kill, CLI crash). Complete the call in
    // flight anyway: a killed run never returns an outcome, so the live channel is the ONLY record
    // of what it spent, and dropping its last turn is what the streaming exists to avoid. No
    // terminal `result` event arrived, so there is no cumulative total to reconcile against and no
    // remainder row to file — every captured turn already streamed as it was completed.
    telemetry.flush()
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
    toolWindow.close()
    await subagents?.stop()
    await home.dispose()
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
  /** This run's per-call telemetry, settled here with the terminal usage. */
  capture: ClaudeCallCapture
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
  const { summary, stats, stderrTail, capture, usage, subagents } = args
  const calls = capture.calls
  // What the parent's narrated turns did not account for, as its OWN row (never tokens grafted onto
  // a real turn).
  capture.settleUsage(usage)
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

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/**
 * The assistant text a codex event carries, or `''`. Two shapes because the CLI changed its
 * stream between versions and the harness serves both: the flat `agent_message*` events and the
 * newer `item.completed` envelope around a message item.
 */
function codexAssistantText(event: Record<string, unknown>, type: string): string {
  const isMessage =
    type.includes('agent_message') || (type === 'item.completed' && isCodexMessageItem(event))
  return (isMessage ? extractText(event) : '') ?? ''
}

/**
 * Whether a codex event reports tool activity — a substring test because the CLI names these
 * events differently across versions (`exec_command_end`, `item.*` around a command execution,
 * `tool_*`) and the harness cares only that SOMETHING ran.
 *
 * This is also the tool-silence watchdog's only signal on this stream. Codex exposes no
 * structured tool bodies, so `runCodex` produces no `ToolSpan` at all, and a window keyed on the
 * trajectory would have force-failed every codex pass that outran it while the run was working.
 */
function isCodexToolActivity(type: string): boolean {
  return type.includes('tool') || type.includes('command') || type.includes('exec')
}

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

  // The per-run `CODEX_HOME` — the credential, the config and the generated-output redirect — is
  // a lifecycle of its own, in `codex-home.ts`. Ambient mode answers no home: the developer's
  // own CLI login, with nothing written and nothing to tear down.
  const { home: codexHome, images } = await createCodexHome(opts)

  // Codex has no system-prompt flag, so fold the composed role + best-practice
  // context into the prompt itself (Claude Code instead rides --append-system-prompt,
  // falling back to this same fold when the prompt overflows argv).
  //
  // An image capability that could NOT be honoured is stated in the same fold, because the
  // backend's brief has already promised it and only this half knows it is missing. Absent for
  // every ordinary run, which is byte-for-byte the prompt it composed before.
  const gap = codexImageGapNote(images)
  const prompt = foldSystemPrompt(
    opts.systemPrompt,
    gap ? `${opts.userPrompt}\n\n${gap}` : opts.userPrompt,
  )
  // This stream's tool-silence window (see the claude runner for the shape); opened just before
  // the CLI starts and closed in the `finally` below.
  let toolWindow: ToolProgressWindow = NO_TOOL_WINDOW

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
    const text = codexAssistantText(event, type)
    if (text) {
      stats.assistantChars += text.length
      summary = text
      pendingText = text
    }
    if (isCodexToolActivity(type)) {
      stats.toolCalls += 1
      toolWindow.toolCompleted()
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

  toolWindow = openToolWindow(opts)
  try {
    const { stderrTail } = await streamCli(
      {
        command: 'codex',
        args: [
          'exec',
          '--json',
          '--skip-git-repo-check',
          // No `--tools` analogue here, and its absence is a FINDING rather than an oversight:
          // codex has no flag that declares a built-in tool set, because it has no set to choose
          // from. Its surface is shell + apply_patch + the plan tool, and the optional extras are
          // individual `CODEX_HOME/config.toml` switches the harness already sets deliberately
          // (`[features] image_generation`, see `codex-home.ts`). So there is nothing here that
          // silently drifts with a CLI version the way claude-code's headless default did.
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
    toolWindow.close()
    if (codexHome) await disposeCodexHome(codexHome, opts, images)
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
