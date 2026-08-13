import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import {
  CliInlineLanguageModel,
  type InlineCliRequest,
  type InlineCliResult,
  type InlineCliRunner,
  type InlineCliTelemetry,
} from '@cat-factory/agents'
// The ONE Claude Code `stream-json` per-call fold, shared with the container harness that owns it.
// See its header for why there must not be a second one.
import {
  createClaudeRunTelemetry,
  subagentDispatchId,
  type ClaudeRunTelemetry,
} from '@cat-factory/executor-harness/claude-call-aggregator'
import {
  describeError,
  describeProcessExit,
  type HarnessCallMetric,
  type HarnessKind,
  type InlineLlmCallRecorder,
  isAmbientNativeVendor,
  isIndividualVendor,
  type ModelProvider,
  type ModelProviderResolver,
  type ModelRef,
  type ModelScope,
  nativeVendorForRef,
  redactSecrets,
  SUBSCRIPTION_VENDORS,
  type SubscriptionVendor,
  subscriptionVendorForRef,
} from '@cat-factory/kernel'
import { logger, parseTimerEnvMs } from '@cat-factory/server'
import type { InlineContainerRequest } from './LocalContainerRunnerTransport.js'
import type { InlineJobResult } from './harnessHttp.js'
import { sanitizedChildEnv } from './childEnv.js'

// Local-mode INLINE harness execution: run the developer's ambient `claude` / `codex` CLI as a
// host subprocess to serve the inline LLM steps (requirements reviewer, brainstorm,
// task-estimator, inline document kinds) on a subscription model. Gated by `LOCAL_NATIVE_INLINE`
// (default ON), DECOUPLED from the container-native `LOCAL_NATIVE_AGENTS` opt-in — an inline step
// is a one-shot text call (no repo checkout, no tools), so running it on the local CLI is benign
// and on by default. Only NATIVE ambient vendors qualify (`claude` / `codex`, no injected
// credential); a non-native claude-code vendor (GLM/Kimi/DeepSeek) keeps degrading to a provider
// model, exactly as `nativeVendorForRef` / `isAmbientNativeVendor` gate the container path — so
// the guard's `inlineHarnessRef` predicate and this provider agree on what can run inline.

/** How the caller wants a CLI run supervised, and how it wants the output delivered. */
export interface CliExecOptions {
  signal?: AbortSignal
  /**
   * Kill the run once it has produced NOTHING on either stream for this long. Re-armed by every
   * chunk, so it bounds how long the CLI may be STUCK rather than how long it may work.
   * Default {@link DEFAULT_CLI_IDLE_TIMEOUT_MS}.
   */
  idleTimeoutMs?: number
  /**
   * Kill the run once its total wall-clock exceeds this, however busy it looks — the backstop for a
   * run that narrates forever and therefore never trips the idle budget.
   * Default {@link DEFAULT_CLI_MAX_TIMEOUT_MS}.
   */
  maxTimeoutMs?: number
  /**
   * Consume stdout LINE BY LINE as it arrives, INSTEAD of buffering the body — the two are
   * mutually exclusive, and supplying this is what keeps a streaming vendor's output out of the
   * orchestrator's memory (see {@link spawnCliExec}). The promise then resolves with `''`: the
   * observer is the only account of the stream, so a caller that supplies one must not also
   * expect a body.
   *
   * Lines arrive without their terminator, in order, and the final line is flushed on close even
   * when the CLI was killed mid-write — so an observer must tolerate a truncated last line.
   *
   * MUST NOT THROW. It runs inside the stream's `data` handler, where a rejection would escape
   * the promise entirely and leave the run unsettled; the one implementation
   * ({@link ClaudeStreamFold.line}) is total by construction.
   */
  onLine?: (line: string) => void
}

/**
 * Runs a CLI once: feed the prompt over stdin, deliver stdout (buffered, or streamed line-by-line
 * via {@link CliExecOptions.onLine}), reject on non-zero exit, abort, or timeout. The injectable
 * seam ({@link CliExec}) so the vendor runners below are unit-testable with a fake process
 * (mirroring the injectable exec every other local subprocess transport takes) — the default is
 * the real {@link spawnCliExec}.
 */
export type CliExec = (
  command: string,
  args: string[],
  stdin: string,
  opts?: CliExecOptions,
) => Promise<string>

/**
 * How long a run may go with NOTHING on either stream before it is presumed hung and killed.
 *
 * A hung ambient CLI (network stall, an approval prompt not covered by the bypass flags, a
 * subprocess blocked on stdin) emits neither `close` nor `error`, so without a watchdog the inline
 * step would park forever — the callers pass no AbortSignal.
 *
 * Measured from the LAST byte, not from the spawn: this budget used to be the whole run's, which
 * killed a step for being SLOW rather than for being stuck. `stream-json` narrates a healthy
 * `claude` continuously (one envelope per assistant turn, per `tool_use`, per tool result), so
 * silence this long is a real symptom, while total elapsed time is not — a legitimate research step
 * runs many minutes and hundreds of events. The observed regression was a `doc-researcher` killed
 * at exactly 5 minutes having made 53 model calls and burned 2.9M tokens, mid-turn.
 */
const DEFAULT_CLI_IDLE_TIMEOUT_MS = 300_000
/**
 * The absolute wall-clock ceiling, whatever the run is doing.
 *
 * An idle budget alone cannot bound a run that keeps NARRATING forever (a tool loop that never
 * converges still prints an envelope per iteration, so it never looks idle), and these callers pass
 * no AbortSignal — so something has to end it. Deliberately far above any legitimate inline step:
 * this is the backstop that keeps a pathological run from owning the process for a day, not a
 * latency budget, and a run that hits it is reported as having hit a ceiling rather than as hung.
 */
const DEFAULT_CLI_MAX_TIMEOUT_MS = 3_600_000
/**
 * The env vars the two budgets above are configured from.
 *
 * Constants rather than literals because the names are read in TWO places that must agree:
 * {@link inlineCliBudgetFromEnv}, which parses them, and the ceiling failure message, which tells
 * the operator which one to raise. A rename that updated only the parser would leave the message
 * naming a variable that no longer exists — advice that is worse than none, since it reads as
 * authoritative. This module owns both ends, so the coupling belongs here and not in a doc.
 */
export const INLINE_CLI_BUDGET_VARS = {
  idle: 'LOCAL_INLINE_CLI_IDLE_TIMEOUT_MS',
  max: 'LOCAL_INLINE_CLI_MAX_TIMEOUT_MS',
} as const
// A CLI that ignores SIGTERM is escalated to SIGKILL after this grace period.
const KILL_GRACE_MS = 2_000
/** How much of the CLI's output a failure message carries. Tail-biased: the error is at the end. */
const EXIT_OUTPUT_TAIL_CHARS = 700
/**
 * How much of EACH stream is retained for that message. The bound applies to stdout as well as
 * stderr, and on the streaming path it is the ONLY stdout the spawn holds: `stream-json` output is
 * unbounded in a way the one-shot `json` object never was (every assistant envelope, every
 * `tool_use` input and every tool_result, for as long as the watchdog allows), and this runner
 * bypasses permissions, so a stalled tool-using run would otherwise park hundreds of MB in the
 * orchestrator process — precisely on the runs worth diagnosing. The container harness's
 * `streamCli` retains no body for the same reason.
 */
const OUTPUT_TAIL_RETAIN_CHARS = 8_000

/**
 * The message a badly-ended inline CLI fails with.
 *
 * `claude -p` reports an API refusal (quota, rate limit, auth) as JSON on STDOUT and leaves stderr
 * EMPTY, so a stderr-only message carries nothing but the exit code, and the reason the caller's
 * in-band `is_error` check would have surfaced is dropped on the floor. Carry whichever stream
 * actually spoke, and say so when neither did rather than trailing off after a colon.
 *
 * Both streams are command output, so both are scrubbed at this emit site — the sibling in the
 * container harness (`streamCli`) redacts its stderr tail for the same reason, and stdout here is
 * strictly more exposed since it holds the model's own text. Scrub BEFORE the tail slice, so a
 * partially-cut credential cannot survive by being unrecognisable to the pattern rules.
 */
function cliExitMessage(
  command: string,
  code: number | null,
  killSignal: NodeJS.Signals | null,
  stderr: string,
  stdout: string,
): string {
  const spoke = stderr.trim() || stdout.trim()
  const tail = (redactSecrets(spoke) ?? '').slice(-EXIT_OUTPUT_TAIL_CHARS) || '(no output)'
  return `${command} ${describeProcessExit(code, killSignal)}: ${tail}`
}

/**
 * How long a run must have been quiet before its silence is worth reporting. Mirrors the container
 * harness's `SILENCE_BREADCRUMB_MS` and its reasoning: without the threshold every fast failure (a
 * missing binary, an auth rejection) would gain a true-but-useless "said nothing" clause for a
 * phase where the CLI was never going to have spoken yet.
 */
const SILENCE_BREADCRUMB_MS = 30_000

/**
 * How quiet the run had gone before it died, or `''` when silence isn't part of the story. Exit
 * status alone can't separate a CLI that stalled from one that died on its first line — and for the
 * watchdog kill silence IS the whole diagnosis, because the message otherwise reports only that the
 * budget elapsed.
 *
 * The container harness's twin says "no activity" because its channel also carries synthetic
 * keep-alive beats. Here the channel is literally the child's stdout/stderr, so this claims exactly
 * that much and no more: the CLI itself was silent.
 *
 * Exported for its own test (like {@link spawnCliExec}): reaching the threshold through a real
 * subprocess would mean a 30s test.
 */
export function silenceClause(
  startedAt: number,
  lastOutputAt: number | undefined,
  now: number,
): string {
  const silentMs = now - (lastOutputAt ?? startedAt)
  if (silentMs < SILENCE_BREADCRUMB_MS) return ''
  const secs = Math.round(silentMs / 1000)
  return lastOutputAt === undefined ? `no output at all in ${secs}s` : `silent for ${secs}s`
}

/** Why a CLI run ended badly. Structured because the message is prose a caller extends. */
export type CliExecFailureReason = 'timeout' | 'aborted' | 'exit'

/**
 * A CLI run that ended badly, carrying what only the SPAWN SITE knows: how it died, and (already
 * folded into `message`) how quiet it had gone.
 *
 * It deliberately carries NO output. The spawn site could not interpret a partial stream anyway —
 * only the vendor knows its own format — so the evidence accumulates in the vendor's own observer
 * ({@link ClaudeStreamFold}, fed through {@link CliExecOptions.onLine}) and is still there to be
 * read after the rejection. That split is what lets a killed run report what it spent without the
 * spawn holding the stream: before it, the watchdog and abort paths rejected with the bare fact
 * that the budget had elapsed, so a run that burned millions of tokens read exactly like one that
 * never reached the model.
 *
 * A caller that ENRICHES the message re-throws a `CliExecFailure` rather than a plain `Error`
 * ({@link withBurnClause}), so `reason` survives the enrichment on the error itself and not only
 * down the `cause` chain.
 */
export class CliExecFailure extends Error {
  constructor(
    message: string,
    readonly reason: CliExecFailureReason,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CliExecFailure'
  }
}

/** Keep only the trailing {@link OUTPUT_TAIL_RETAIN_CHARS} of a stream. */
function retainTail(buffer: string): string {
  return buffer.length > OUTPUT_TAIL_RETAIN_CHARS ? buffer.slice(-OUTPUT_TAIL_RETAIN_CHARS) : buffer
}

/** The default {@link CliExec}: a real `node:child_process` spawn with a timeout watchdog.
 * Exported for its own tests (the sanitized-env contract); callers use the runner builders. */
export const spawnCliExec: CliExec = (command, args, stdin, opts = {}) =>
  new Promise((resolve, reject) => {
    const {
      signal,
      idleTimeoutMs = DEFAULT_CLI_IDLE_TIMEOUT_MS,
      maxTimeoutMs = DEFAULT_CLI_MAX_TIMEOUT_MS,
      onLine,
    } = opts
    if (signal?.aborted) {
      // Deliberately a plain Error, not a {@link CliExecFailure}: nothing ran, so there is no
      // stream to account for and no silence to measure. The message already says as much, and the
      // vendor runner passes a non-`CliExecFailure` through untouched rather than appending a
      // redundant "no model call completed".
      reject(new Error(`${command} aborted before start`))
      return
    }
    // The inline CLI runs IN the orchestrator process's environment — sanitize it down to
    // the allow-list so the agent never inherits the backend's secrets (DATABASE_URL,
    // ENCRYPTION_KEY, GITHUB_PAT, …), mirroring the host-process harness transport.
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizedChildEnv(process.env),
    })
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
    // Decode on the STREAM, not per chunk: a multi-byte character split across a chunk boundary
    // decodes to replacement characters when each `Buffer` is stringified alone, and `onLine`
    // hands these lines to `JSON.parse` — one unlucky boundary would silently drop an event (and
    // its usage) from the fold. `setEncoding` holds the partial sequence back instead.
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    /** The full stdout — retained ONLY when no `onLine` consumer took the stream instead. */
    let body = ''
    /** Bounded tail of stdout, always retained: the failure message needs it either way. */
    let stdoutTail = ''
    let stderr = ''
    /** Carry for a chunk boundary that fell mid-line (streaming path only). */
    let lineBuffer = ''
    // When the child last spoke on EITHER stream, so a failure can say how long it had been quiet.
    // `undefined` until the first byte — the honest distinction between a run that went quiet and
    // one that never produced anything at all.
    const startedAt = Date.now()
    let lastOutputAt: number | undefined
    // WHY it was killed, kept apart from the reported `reason` (both kills are a `timeout` to a
    // caller): only this distinguishes "stuck" from "ran past the ceiling", and the two want
    // opposite reactions from whoever reads the failure — restart it vs give it more room.
    let killedReason: 'aborted' | 'idle' | 'ceiling' | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    // Terminate the child (SIGTERM), escalating to SIGKILL if it doesn't exit promptly.
    //
    // FIRST kill wins. Every trigger stays armed until `close`, so a second one can land inside the
    // SIGKILL grace period — an abort arriving while an idle kill is still escalating used to
    // overwrite `killedReason`, and `reason` is what a CALLER switches on, so the run surfaced as
    // `aborted` rather than the timeout that actually ended it. Re-entering would also orphan the
    // running `killTimer`. The same "a kill is already in flight" idiom guards `noteOutput`.
    const terminate = (reason: 'aborted' | 'idle' | 'ceiling'): void => {
      if (killedReason) return
      killedReason = reason
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }
    const onAbort = (): void => terminate('aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
    // The idle watchdog is RE-ARMED by every chunk (see `noteOutput`), so it measures the gap
    // between bytes; the ceiling is armed once and never touched, so it measures the whole run.
    let idleWatchdog = setTimeout(() => terminate('idle'), idleTimeoutMs)
    idleWatchdog.unref?.()
    const ceiling = setTimeout(() => terminate('ceiling'), maxTimeoutMs)
    ceiling.unref?.()
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(idleWatchdog)
      clearTimeout(ceiling)
      if (killTimer) clearTimeout(killTimer)
    }
    /**
     * Record that the child spoke: stamp the time the failure message measures silence from, and
     * push the idle deadline out. Called from BOTH stream handlers — stderr counts as liveness too
     * (a CLI narrating progress to stderr is not stuck), which is also why `lastOutputAt` has
     * always been stamped on both.
     */
    const noteOutput = (): void => {
      lastOutputAt = Date.now()
      // Nothing to re-arm once the kill is already in flight: the child is dying, and a fresh timer
      // would only fire against a settled promise (and hold the loop for another whole budget on a
      // process that ignores SIGTERM until the SIGKILL escalation lands).
      if (killedReason) return
      clearTimeout(idleWatchdog)
      idleWatchdog = setTimeout(() => terminate('idle'), idleTimeoutMs)
      idleWatchdog.unref?.()
    }
    child.stdout.on('data', (chunk: string) => {
      noteOutput()
      stdoutTail = retainTail(stdoutTail + chunk)
      if (!onLine) {
        body += chunk
        return
      }
      lineBuffer += chunk
      let nl = lineBuffer.indexOf('\n')
      while (nl !== -1) {
        const line = lineBuffer.slice(0, nl)
        lineBuffer = lineBuffer.slice(nl + 1)
        nl = lineBuffer.indexOf('\n')
        onLine(line)
      }
    })
    child.stderr.on('data', (chunk: string) => {
      noteOutput()
      stderr = retainTail(stderr + chunk)
    })
    child.on('error', (err) => {
      cleanup()
      reject(err)
    })
    // `killSignal`, not `signal`: the outer `signal` in scope here is the caller's AbortSignal,
    // and shadowing it with the exit signal would silently hand the wrong value to any later
    // line in this handler that reaches for it.
    child.on('close', (code, killSignal) => {
      cleanup()
      // Flush the trailing line BEFORE settling, so the observer sees the whole stream. It has no
      // terminator in two cases that matter: a clean run whose terminal `result` event is the last
      // thing written, and a killed one cut mid-JSON. The observer drops what it can't parse.
      if (onLine && lineBuffer) {
        const last = lineBuffer
        lineBuffer = ''
        onLine(last)
      }
      // Every bad end goes out as a {@link CliExecFailure} naming HOW it died and (below) how quiet
      // it had gone. The watchdog and abort paths used to reject with the bare fact that the budget
      // elapsed — no timing, nothing about what the run had already done — which made a run that
      // burned through a poll budget indistinguishable from one that never reached the model. What
      // it consumed is added by the vendor runner, off the observer it fed.
      const failed = (reason: CliExecFailureReason, base: string, silence = true): void => {
        const clause = silence ? silenceClause(startedAt, lastOutputAt, Date.now()) : ''
        reject(new CliExecFailure(clause ? `${base}; ${clause}` : base, reason))
      }
      // Both watchdogs report `timeout` — what a caller switches on is unchanged — but they say
      // DIFFERENT things, because the fix is different: an idle kill means the CLI stopped talking
      // (retry it), a ceiling kill means it was still working and the ceiling is too low (raise it).
      if (killedReason === 'idle') {
        // No silence clause here: this message IS the silence statement, and appending "silent for
        // 300s" to "no output for 300000ms" would just say it twice with rounding drift between them.
        failed('timeout', `${command} timed out after ${idleTimeoutMs}ms with no output`, false)
        return
      }
      if (killedReason === 'ceiling') {
        // The clause EARNS its place on this path: it is what separates a run killed while actively
        // streaming from one that had also gone quiet inside the final idle window.
        failed(
          'timeout',
          `${command} hit its ${maxTimeoutMs}ms wall-clock ceiling ` +
            `(raise ${INLINE_CLI_BUDGET_VARS.max})`,
        )
        return
      }
      if (killedReason === 'aborted') {
        failed('aborted', `${command} aborted`)
        return
      }
      if (code !== 0) {
        // BOTH streams, not just stderr — see {@link cliExitMessage} for why, and for what is
        // scrubbed out of them on the way. The stdout TAIL, since that is all either path holds.
        failed('exit', cliExitMessage(command, code, killSignal, stderr, stdoutTail))
        return
      }
      // `''` on the streaming path, by contract: the observer already has the stream.
      resolve(body)
    })
  })

/**
 * Read the CLI's Anthropic usage into the three ORTHOGONAL input classes, mirroring the
 * harness's `claudeCallUsage`. `input_tokens` is already exclusive of both caches, so nothing
 * is subtracted here — and the classes are deliberately NOT summed into one figure: this path
 * is the one place a local deployment's inline steps are observable at all, and a lumped count
 * cannot say whether a run is riding a warm cache (~0.1× base input) or re-writing it every
 * turn (1.25–2×).
 */
function claudeUsage(raw: unknown): InlineCliResult['usage'] {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  const input = num(r.input_tokens)
  const cacheRead = num(r.cache_read_input_tokens)
  const cacheWrite = num(r.cache_creation_input_tokens)
  const output = num(r.output_tokens)
  if (input === 0 && cacheRead === 0 && cacheWrite === 0 && output === 0) return undefined
  return {
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
  }
}

// Claude Code reports failures IN-BAND (process exit 0) via `is_error` / an `error_*` subtype,
// with the error text in `result`. Left unchecked, that error string would be handed back as a
// "successful" reviewer answer and parsed as a real (garbage) review; surface it as a throw so
// the run fails instead. (These one-shot CLIs expose no token-length stop reason, so an
// output-cap truncation is UNDETECTABLE on this path and the reviewer's `finishReason ===
// 'length'` guard only fires for HTTP providers. It is reported as an ABSENT finish reason
// rather than as `stop`, so a reader can tell "not measurable here" from "measured, clean".
// `error_max_turns` is the closest limit signal these CLIs give.)
const CLAUDE_ERROR_SUBTYPES = new Set(['error_max_turns', 'error_during_execution'])

/**
 * How much non-event output the fold retains for the {@link ClaudeStreamFold.fallbackText}
 * fallback. Only ever reached by a CLI that does not speak `stream-json` at all, whose whole
 * output is one short answer.
 */
const FALLBACK_BODY_MAX_CHARS = 64 * 1024

/**
 * Reads Claude Code's `stream-json` output AS IT ARRIVES, routing it to the two things that need
 * it: the SHARED per-call aggregator (which publishes each model call the moment the CLI finishes
 * it), and this class's own account of the run — the terminal `result` event, the raw-text
 * fallback, and a running total for the failure breadcrumb.
 *
 * Fed line-by-line through {@link CliExecOptions.onLine}, so it never holds the stream, and it stays
 * readable after a REJECTION — which is what lets a killed run say what it spent.
 *
 * What it DOES retain is the aggregator's reconstructed request transcript, and that is retained in
 * THIS process, so it is bounded on two axes rather than left to grow with the loop: the
 * aggregator's own `MAX_TRANSCRIPT_CHARS` (which states what it stopped retaining), and the
 * `bodies` switch, which skips the reconstruction entirely when the deployment retains no prompts.
 * Without both, a stalled tool-using run parks the same hundreds of MB here that
 * {@link OUTPUT_TAIL_RETAIN_CHARS} exists to refuse.
 *
 * The per-call fold is DELIBERATELY not implemented here. The stream emits one envelope per
 * CONTENT BLOCK of a response, each repeating that ONE call's `usage` — a turn that answers with
 * text then fires five tool calls arrives as six envelopes — so folding by `message.id` before
 * summing is the difference between 31 calls and 117 (a measured 1.47M tokens inflated to 5.53M,
 * 3.8x). `createClaudeRunTelemetry` is where that is solved, along with the prompt-transcript
 * reconstruction and the routing of subagent turns off the parent's chain; this module used to
 * carry a lesser copy of the same fold, which is exactly why the two paths disagreed about how
 * many calls a step had made. See docs/initiatives/token-burn-instrumentation.md.
 *
 * {@link line} and {@link end} are TOTAL: they parse defensively, and every fold step runs through
 * {@link ClaudeStreamFold.fold}, which is the contract {@link CliExecOptions.onLine} demands of an
 * observer running inside a stream handler.
 */
class ClaudeStreamFold {
  private readonly telemetryStream: ClaudeRunTelemetry
  private terminal: Record<string, unknown> | undefined
  private nonEventText = ''
  private sawEvent = false
  private calls = 0
  private readonly total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  private readonly log = logger.child({ scope: 'claudeStreamFold' })
  /** Whether a fold failure has already been reported — one line per run, not per line. */
  private foldFailed = false

  /**
   * @param seed the turns the harness supplied and the stream therefore never shows (system +
   *   user), so a reconstructed prompt never claims a turn that was not sent.
   * @param reportCall where each model call the CLI reports goes. Absent ⇒ the calls are still
   *   counted for the breadcrumb, but nothing is published.
   * @param bodies whether the published metrics' bodies will be retained anywhere. False ⇒ the
   *   transcript is not reconstructed at all (counts only), because assembling a body the store is
   *   about to drop is pure cost in THIS process.
   */
  constructor(
    seed: { role: string; content: unknown }[],
    private readonly reportCall?: (call: HarnessCallMetric) => void,
    bodies = false,
  ) {
    this.telemetryStream = createClaudeRunTelemetry({
      seed,
      // The host-CLI path runs on the developer's own AMBIENT login: no credential was injected
      // into this subprocess, so no secret of ours can be echoed back in a body. (The container
      // inline path leases one, and redacts inside the harness where the lease is known.)
      secrets: [],
      // No `subagents/*.jsonl` watcher runs against an ambient CLI — it has no isolated config
      // home to watch — so any subagent turns are billed HERE, on transcripts of their own.
      watcherOwnsSubagents: false,
      bodies,
      publish: (metric) => {
        // Only the calls that got as far as reporting a burn count toward the breadcrumb, so a
        // stream of empty ones can't read as "burned 0 tokens across 3 model calls" and contradict
        // the `no model call completed` branch. Every metric is still PUBLISHED: whether an
        // uncosted turn is fileable is one rule for both transports, and it lives with the model
        // that files them.
        if (
          metric.inputTokens ||
          metric.cacheReadTokens ||
          metric.cacheWriteTokens ||
          metric.outputTokens
        ) {
          this.calls += 1
          this.total.input += metric.inputTokens
          this.total.cacheRead += metric.cacheReadTokens
          this.total.cacheWrite += metric.cacheWriteTokens
          this.total.output += metric.outputTokens
        }
        // Isolated, because this is a CALLER's callback running in the middle of the aggregator's
        // own state transition (a call completes when the next one's first envelope arrives). Left
        // to propagate, one throwing report would abandon that transition and cost the telemetry of
        // the call that was just starting — on top of escaping into the stream handler.
        this.fold('publish', () => this.reportCall?.(metric))
      },
    })
  }

  line(raw: string): void {
    if (!raw.trim()) return
    let event: unknown
    try {
      event = JSON.parse(raw)
    } catch {
      this.retainNonEvent(raw) // a wrapper/progress line, or a last line cut mid-JSON
      return
    }
    if (typeof event !== 'object' || event === null) {
      this.retainNonEvent(raw)
      return
    }
    // The CLI is speaking `stream-json`, so the event stream IS its body: stop retaining raw text
    // for good. Retention exists only for a CLI that never emits an event at all.
    this.sawEvent = true
    this.nonEventText = ''
    const e = event as Record<string, unknown>
    // The terminal event, the same object `--output-format json` used to emit on its own. LAST one
    // wins: it is the run's authoritative account of itself.
    if (e.type === 'result') {
      this.terminal = e
      return
    }
    // A subagent's turns ride the parent's stdout tagged with the dispatch that spawned them; the
    // telemetry keeps them off the parent's chain (interleaving several conversations produces a
    // `promptText` matching no request that was ever sent).
    const dispatchId = subagentDispatchId(e)
    const message = e.message
    if (typeof message !== 'object' || message === null) return
    const m = message as Record<string, unknown>
    if (e.type === 'assistant') {
      this.fold('assistant', () => this.telemetryStream.onAssistant(dispatchId, m))
      return
    }
    if (e.type === 'user') {
      // The tool_result blocks fed back to the model — part of the NEXT call's prompt.
      const content = m.content
      if (Array.isArray(content)) {
        this.fold('toolResult', () => this.telemetryStream.onToolResult(dispatchId, content))
      }
    }
  }

  /**
   * Publish the call still in flight. Called once the stream has ended, on BOTH the clean and the
   * killed path — on a kill it is what puts the interrupted turn's spend on record instead of
   * losing it with the subprocess.
   */
  end(): void {
    this.fold('flush', () => this.telemetryStream.flush())
  }

  /**
   * Run one fold step, absorbing anything it throws.
   *
   * This is what keeps {@link line} TOTAL — the contract {@link CliExecOptions.onLine} demands of an
   * observer running inside a stream handler, since a throw there escapes into the spawn's `stdout`
   * listener. The fold is not trivially total: it serialises the reconstructed transcript, which can
   * exceed the engine's string limit on exactly the long tool loops this telemetry exists for.
   *
   * It also keeps {@link end} total, which matters on the KILLED path: `end()` runs there before the
   * failure is enriched with what the run had burned, so a throw would replace a `CliExecFailure`
   * (losing its `reason` and its burn clause) with an unrelated telemetry error.
   *
   * Reported ONCE per run — a broken fold breaks on every line, and this observer must not turn a
   * telemetry defect into thousands of log lines during a live run.
   */
  private fold(step: string, apply: () => void): void {
    try {
      apply()
    } catch (error) {
      if (this.foldFailed) return
      this.foldFailed = true
      this.log.warn('claude stream telemetry fold failed; per-call rows may be incomplete', {
        step,
        ...describeError(error),
      })
    }
  }

  private retainNonEvent(raw: string): void {
    if (this.sawEvent || this.nonEventText.length >= FALLBACK_BODY_MAX_CHARS) return
    this.nonEventText = this.nonEventText ? `${this.nonEventText}\n${raw}` : raw
  }

  /** The run's terminal `result` event, or `undefined` if it never reached one. */
  get result(): Record<string, unknown> | undefined {
    return this.terminal
  }

  /** What a CLI that emitted no events at all wrote, for the raw-text fallback. */
  get fallbackText(): string {
    return this.nonEventText.trim()
  }

  /** Cumulative burn across the calls published so far — the failure breadcrumb's numbers. */
  telemetry(): { calls: number; usage: InlineCliResult['usage'] } {
    return {
      calls: this.calls,
      usage:
        this.calls === 0
          ? undefined
          : {
              inputTokens: this.total.input,
              cacheReadTokens: this.total.cacheRead,
              cacheWriteTokens: this.total.cacheWrite,
              outputTokens: this.total.output,
            },
    }
  }
}

/** Compact token counts: a breadcrumb is read by a human, not summed by anything. */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

/**
 * What the run consumed before it died, in the two terms that change the diagnosis: whether the
 * model was reached at all, and whether a warm cache carried the input (`claudeUsage` keeps the
 * input classes apart for precisely this reason — a cache-heavy run is ~0.1x the base rate).
 */
function claudeBurnClause(calls: number, usage: InlineCliResult['usage']): string {
  if (calls === 0 || !usage) return 'no model call completed'
  const total =
    (usage.inputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0) +
    (usage.outputTokens ?? 0)
  return (
    `burned ${formatTokens(total)} tokens ` +
    `(${formatTokens(usage.cacheReadTokens ?? 0)} cache-read) ` +
    `across ${calls} model call${calls === 1 ? '' : 's'}`
  )
}

/**
 * How long a host-CLI inline run may stall, and how long it may run at all — the deployment-level
 * supervision budget, resolved once at wiring time and handed to every runner.
 *
 * A partial bag rather than two required numbers so a caller can set one knob and inherit the other
 * default, which is how both env vars are documented to behave.
 */
export interface InlineCliBudget {
  idleTimeoutMs?: number
  maxTimeoutMs?: number
}

/**
 * Read the inline host-CLI supervision budget from the environment.
 *
 * Both knobs exist because the defaults cannot fit every machine: an inline `doc-researcher` on a
 * slow link legitimately stalls longer than {@link DEFAULT_CLI_IDLE_TIMEOUT_MS} inside one long
 * model turn, and a deployment that runs deliberately large inline steps wants a ceiling above
 * {@link DEFAULT_CLI_MAX_TIMEOUT_MS}. Before them the 5-minute budget was a hard-coded constant with
 * no seam at all, so a deployment whose steps outgrew it had no way to say so.
 *
 * An unusable value WARNS and falls back to the default rather than throwing or silently coercing:
 * `LOCAL_INLINE_CLI_IDLE_TIMEOUT_MS=5m` is a typo whose author should hear about it, but it is not
 * worth refusing to boot the whole deployment over. Validation is `parseTimerEnvMs`, which is
 * stricter than the general `parseNumericEnv` for the reason that governs this whole module: every
 * unusable spelling of a timer budget makes `setTimeout` fire IMMEDIATELY, so one typo here kills
 * every inline step on the deployment at once rather than degrading one of them.
 */
export function inlineCliBudgetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  onWarn?: (message: string) => void,
): InlineCliBudget {
  const read = (name: string, fallback: number): number | undefined => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return undefined
    const parsed = parseTimerEnvMs(name, raw, fallback)
    if ('rejected' in parsed) {
      onWarn?.(`local mode: ${parsed.rejected}`)
      return undefined
    }
    return parsed.ms
  }
  const idleTimeoutMs = read(INLINE_CLI_BUDGET_VARS.idle, DEFAULT_CLI_IDLE_TIMEOUT_MS)
  const maxTimeoutMs = read(INLINE_CLI_BUDGET_VARS.max, DEFAULT_CLI_MAX_TIMEOUT_MS)
  // A ceiling below the idle budget makes the idle watchdog unreachable: the run always dies of the
  // ceiling first, so a genuinely STUCK CLI is reported as one that ran too long and the operator
  // goes and raises the wrong number.
  //
  // Compared on the EFFECTIVE values, not just the explicitly-set ones. Lowering only the ceiling —
  // `LOCAL_INLINE_CLI_MAX_TIMEOUT_MS=60000` against the 300000ms default idle window — is the more
  // likely single-knob edit of the two (bounding runaway runs is why an operator comes here at all)
  // and produces exactly the same incoherence; gating on both being set would let it through in
  // silence. Nothing is rewritten: the pair stands as configured and the warning is the whole remedy,
  // because which of the two the operator meant is not ours to guess.
  const effectiveIdle = idleTimeoutMs ?? DEFAULT_CLI_IDLE_TIMEOUT_MS
  const effectiveMax = maxTimeoutMs ?? DEFAULT_CLI_MAX_TIMEOUT_MS
  if (effectiveMax < effectiveIdle) {
    const named = (value: number | undefined): string => (value === undefined ? ' default' : '')
    onWarn?.(
      `local mode: ${INLINE_CLI_BUDGET_VARS.max} (${effectiveMax}ms${named(maxTimeoutMs)}) is below ` +
        `${INLINE_CLI_BUDGET_VARS.idle} (${effectiveIdle}ms${named(idleTimeoutMs)}), so every ` +
        'stalled inline run will be reported as hitting the ceiling rather than as stuck.',
    )
  }
  return {
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...(maxTimeoutMs !== undefined ? { maxTimeoutMs } : {}),
  }
}

/**
 * A runner for the ambient `claude` CLI. The role rides `--append-system-prompt`; the prompt goes
 * over stdin. Bypass permissions so the headless run never blocks on an approval prompt (an inline
 * text task uses no tools anyway).
 *
 * Streams `--output-format stream-json --verbose` rather than taking the single-object `json`: that
 * lone result object exists ONLY if the CLI reaches the end, so a run the watchdog killed reported
 * nothing whatsoever about what it had already spent. The terminal event carries the same fields
 * the single object did (`-p --output-format json` prints exactly that event), so the success path
 * is unchanged; the difference is that the run's spend is now on record turn by turn, published
 * through `reportCall` as the CLI yields each call rather than assembled at the end. A step that
 * works for eight minutes is therefore observable WHILE it works, and one killed at minute five has
 * every completed turn recorded — where before it produced a single row of zeros, and only once the
 * subprocess had exited.
 *
 * The stream is consumed through {@link ClaudeStreamFold} rather than buffered — see
 * {@link OUTPUT_TAIL_RETAIN_CHARS} for why holding it would be a memory fault on exactly the runs
 * this exists to diagnose. The fold is declared OUTSIDE the try so it is still readable (and
 * flushable) when the run is killed, which is the whole mechanism.
 */
function makeClaudeRunner(exec: CliExec, budget: InlineCliBudget = {}): InlineCliRunner {
  return async (req: InlineCliRequest): Promise<InlineCliResult> => {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      // Required alongside `stream-json` in print mode, exactly as the container harness runs it.
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ]
    if (req.system.trim()) args.push('--append-system-prompt', req.system)
    args.push('--model', req.model)
    // Seeded with what we sent and the stream therefore never echoes. `--append-system-prompt`
    // means the role really was a system turn, so the reconstruction says so.
    const fold = new ClaudeStreamFold(
      [
        ...(req.system.trim() ? [{ role: 'system', content: req.system }] : []),
        { role: 'user', content: req.prompt },
      ],
      req.reportCall,
      req.reportBodies ?? false,
    )
    try {
      await exec('claude', args, req.prompt, {
        onLine: (line) => fold.line(line),
        ...budget,
        ...(req.signal ? { signal: req.signal } : {}),
      })
    } catch (error) {
      // BEFORE enriching: the turn cut off by the kill is only published on flush, and it is the
      // one whose spend would otherwise die with the subprocess.
      fold.end()
      if (error instanceof CliExecFailure) throw withBurnClause(error, fold)
      throw error
    }
    fold.end()
    const result = fold.result
    if (!result) {
      // No terminal event (an older CLI, or a wrapper that swallowed the stream) — fall back to the
      // raw text, as the single-object path did when its JSON wouldn't parse. No `finishReason`:
      // the stream this path exists to cope with is the one that told us nothing.
      return { text: fold.fallbackText }
    }
    const subtype = typeof result.subtype === 'string' ? result.subtype : undefined
    if (result.is_error === true || (subtype && CLAUDE_ERROR_SUBTYPES.has(subtype))) {
      const detail = typeof result.result === 'string' ? result.result : (subtype ?? 'error')
      throw new Error(
        `claude reported an error (${subtype ?? 'is_error'}): ` +
          detail.slice(0, EXIT_OUTPUT_TAIL_CHARS),
      )
    }
    const text = typeof result.result === 'string' ? result.result : ''
    // No `finishReason`: the terminal event says the run did not ERROR, which is not the same as
    // the model having stopped of its own accord, and it carries no stop reason to say which.
    // Claiming `stop` here is what made the caller's output-cap check unfireable.
    //
    // The terminal event's own cumulative figure, not the folded per-call sum: on a run that
    // finished, the CLI's account of itself is authoritative.
    return { text, usage: claudeUsage(result.usage) }
  }
}

/**
 * Re-throw a badly-ended `claude` run with what its PARTIAL stream says it had already consumed.
 *
 * Stays a {@link CliExecFailure} so `reason` is readable on the error a caller actually catches,
 * not only one link down the chain; the un-enriched original rides as `cause` so the raw kill
 * message survives too.
 */
function withBurnClause(failure: CliExecFailure, fold: ClaudeStreamFold): CliExecFailure {
  const { calls, usage } = fold.telemetry()
  return new CliExecFailure(
    `${failure.message}; ${claudeBurnClause(calls, usage)}`,
    failure.reason,
    { cause: failure },
  )
}

/**
 * A runner for the ambient `codex` CLI. Codex has no system-prompt flag, so the composed role is
 * prepended to the prompt (as the harness does), and `codex exec` prints the final assistant
 * message to stdout. Sandbox/approvals are bypassed (the developer's own machine).
 */
function makeCodexRunner(exec: CliExec, budget: InlineCliBudget = {}): InlineCliRunner {
  return async (req: InlineCliRequest): Promise<InlineCliResult> => {
    const prompt = req.system.trim() ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--model',
      req.model,
      '-',
    ]
    // Codex is supervised on the same budget as claude. It prints only its final message rather
    // than a narrated stream, so the idle window is the ONLY thing standing between a wedged
    // `codex exec` and a parked step — and equally the only thing that must not fire while a long
    // one is still thinking.
    const stdout = await exec('codex', args, prompt, {
      ...budget,
      ...(req.signal ? { signal: req.signal } : {}),
    })
    // No `finishReason`: `codex exec` prints its final message and nothing about why it stopped.
    return { text: stdout.trim() }
  }
}

/** Build the inline runner for a native ambient vendor over an injectable CLI exec seam. */
export function runnerForVendor(
  vendor: SubscriptionVendor,
  exec: CliExec = spawnCliExec,
  budget: InlineCliBudget = {},
): InlineCliRunner {
  return vendor === 'codex' ? makeCodexRunner(exec, budget) : makeClaudeRunner(exec, budget)
}

/**
 * Whether a ref can be served as an inline subscription call given the deployment's enabled
 * inline harnesses (`LOCAL_NATIVE_INLINE`) — the single predicate shared by the config
 * (`inlineHarnessRef`, so the start guard treats such a model as inline-satisfiable) and the
 * provider wrapper below (so the two never disagree). Broader than C1's host-CLI-only predicate:
 * with the prewarmed-container backend, ANY subscription vendor whose HARNESS is enabled is
 * inline-servable (host CLI for a native ambient vendor when its binary is present, else the
 * container on a leased credential) — so `glm`/`kimi`/`deepseek` (non-native claude-code
 * vendors) qualify too, not just `claude`/`codex`. Empty allow-list (`LOCAL_NATIVE_INLINE=off`)
 * ⇒ never inline (the start guard then refuses a subscription-only inline step, as before).
 */
export function makeInlineHarnessPredicate(
  inlineHarnesses: readonly HarnessKind[] | undefined,
): (ref: ModelRef) => boolean {
  return (ref) => {
    if (!inlineHarnesses || inlineHarnesses.length === 0) return false
    const vendor = subscriptionVendorForRef(ref)
    return !!vendor && inlineHarnesses.includes(SUBSCRIPTION_VENDORS[vendor].harness)
  }
}

/** Whether a binary is resolvable on the process PATH (sync, no spawn). Windows-aware. */
function binaryOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathValue = env.PATH ?? env.Path ?? ''
  if (!pathValue) return false
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      try {
        accessSync(join(dir, command + ext.toLowerCase()), constants.X_OK)
        return true
      } catch {
        // not here / not executable — keep scanning
      }
    }
  }
  return false
}

/**
 * The set of native ambient vendors (`claude` / `codex`) whose HOST CLI is installed, detected
 * ONCE at wiring time (a PATH scan, no spawn). The provider prefers the host CLI for these
 * (unmetered, the developer's own ambient login); every other case runs in the container on a
 * leased credential. Only the two native vendors are ever host-CLI-served — a non-native vendor
 * (GLM/Kimi/DeepSeek) has no ambient login, so it always goes to the container.
 */
export function detectHostInlineClis(
  env: NodeJS.ProcessEnv = process.env,
): Set<SubscriptionVendor> {
  const present = new Set<SubscriptionVendor>()
  if (binaryOnPath('claude', env)) present.add('claude')
  if (binaryOnPath('codex', env)) present.add('codex')
  return present
}

/** Runs a one-shot inline job inside a leased warm container (the transport's `runInline`). */
type RunInlineInContainer = (req: InlineContainerRequest) => Promise<InlineJobResult>

/** The subscription-credential lease seams the container inline path needs (from buildNodeContainer). */
interface InlineLeaseDeps {
  /** Lease the run-initiator's activated personal credential (individual vendors). */
  leasePersonalSubscriptionToken?: (
    executionId: string,
    userId: string,
    vendor: SubscriptionVendor,
  ) => Promise<{ secret: string }>
  /** Lease a pooled workspace subscription token (poolable vendors). */
  leaseSubscriptionToken?: (
    workspaceId: string,
    vendor: SubscriptionVendor,
  ) => Promise<{ secret: string }>
}

/** Everything the inline resolver wrapper needs to serve subscription refs (host CLI + container). */
export interface InlineHarnessResolverDeps extends InlineLeaseDeps {
  /** The enabled inline harnesses (`LOCAL_NATIVE_INLINE`); empty ⇒ inline off. */
  inlineHarnesses: readonly HarnessKind[]
  /** Native ambient vendors whose host CLI is present (prefer the host CLI for these). */
  hostCliVendors: ReadonlySet<SubscriptionVendor>
  /** Run a one-shot inline job in a warm container. Absent ⇒ container backend unavailable. */
  runInline?: RunInlineInContainer
  /** Injectable host-CLI exec seam (defaults to a real spawn); tests pass a fake. */
  exec?: CliExec
  /**
   * How long a host-CLI run may stall / run in total ({@link inlineCliBudgetFromEnv}). Absent ⇒ the
   * built-in defaults. Only the HOST-CLI path reads it: a container inline job is already bounded by
   * the transport's own `requestTimeoutMs`.
   */
  cliBudget?: InlineCliBudget
  /**
   * Where the calls an inline harness CLI reports are filed — the facade's `llm_call_metrics`
   * recorder, threaded in from `buildNodeModelDeps` (which owns the ONE inline instrumentation).
   *
   * Present ⇒ the model this wrap substitutes files its own per-call rows and the instrumentation
   * middleware around it stands down (`reportsOwnLlmCalls`). Absent ⇒ nothing changes: a
   * deployment that retains no metrics keeps the middleware's single aggregate generation per step.
   */
  recordInlineCall?: InlineLlmCallRecorder
  /**
   * The deployment's `LLM_RECORD_PROMPTS` switch, threaded from the same instrumentation as
   * {@link recordInlineCall}. Absent ⇒ false: the host-CLI reader then reports its calls' counts
   * without reconstructing the request transcripts nothing will keep.
   */
  recordInlineBodies?: boolean
}

/**
 * Build the container-backed {@link InlineCliRunner} for a subscription `vendor`/`ref` and run
 * scope: lease the credential (personal for an individual vendor, pooled otherwise), inject it +
 * the vendor base URL into the `inline` job, and run it in a warm container via `runInline`. The
 * credential is turned into env INSIDE the harness (never here), mirroring the coding path.
 */
function makeContainerRunner(
  vendor: SubscriptionVendor,
  ref: ModelRef,
  scope: ModelScope,
  deps: InlineHarnessResolverDeps,
): InlineCliRunner {
  return async (req: InlineCliRequest): Promise<InlineCliResult> => {
    if (!deps.runInline) {
      throw new Error(
        `Inline ${vendor} model needs the local container backend, which is not available.`,
      )
    }
    let secret: string
    if (isIndividualVendor(vendor)) {
      if (!deps.leasePersonalSubscriptionToken) {
        throw new Error(
          `Personal ${vendor} subscriptions are not configured on this deployment (no ENCRYPTION_KEY).`,
        )
      }
      if (!scope.executionId || !scope.userId) {
        // An individual credential is owned by a specific user and activated per run; without
        // the run/user we can't lease it. (Pooled vendors need only the workspace, below.)
        throw new Error(
          `Running an inline ${vendor} model requires a signed-in user and an active run.`,
        )
      }
      const leased = await deps.leasePersonalSubscriptionToken(
        scope.executionId,
        scope.userId,
        vendor,
      )
      secret = leased.secret
    } else {
      if (!deps.leaseSubscriptionToken) {
        throw new Error(`The ${vendor} subscription pool is not configured on this deployment.`)
      }
      const leased = await deps.leaseSubscriptionToken(scope.workspaceId, vendor)
      secret = leased.secret
    }
    const baseUrl = SUBSCRIPTION_VENDORS[vendor].baseUrl
    const result = await deps.runInline({
      harness: SUBSCRIPTION_VENDORS[vendor].harness,
      model: ref.model,
      system: req.system,
      prompt: req.prompt,
      ...(req.maxOutputTokens != null ? { maxOutputTokens: req.maxOutputTokens } : {}),
      subscriptionToken: secret,
      ...(baseUrl ? { subscriptionBaseUrl: baseUrl } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    })
    // Terminally, not live: a container inline job is awaited over one HTTP call, so its CLI's
    // per-call telemetry only reaches us when the job finishes. Still every turn rather than one
    // lumped row, and the model files them exactly as it files the host CLI's.
    if (req.reportCall) {
      for (const call of result.callMetrics ?? []) req.reportCall(call)
    }
    return {
      text: result.text,
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      ...(result.usage
        ? {
            usage: {
              ...(result.usage.inputTokens != null
                ? { inputTokens: result.usage.inputTokens }
                : {}),
              ...(result.usage.cacheReadTokens != null
                ? { cacheReadTokens: result.usage.cacheReadTokens }
                : {}),
              ...(result.usage.cacheWriteTokens != null
                ? { cacheWriteTokens: result.usage.cacheWriteTokens }
                : {}),
              ...(result.usage.outputTokens != null
                ? { outputTokens: result.usage.outputTokens }
                : {}),
            },
          }
        : {}),
    }
  }
}

/**
 * A {@link ModelProvider} that serves an enabled subscription harness ref inline — host CLI for a
 * native ambient vendor whose binary is present (unmetered, the developer's ambient login), else
 * the prewarmed container on a leased credential — and delegates everything else to `inner`.
 * Built PER-SCOPE so the container runner can lease the run's per-run activation (`scope`).
 */
class SubscriptionInlineModelProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly scope: ModelScope,
    private readonly deps: InlineHarnessResolverDeps,
  ) {}

  resolve(ref: ModelRef): ReturnType<ModelProvider['resolve']> {
    const vendor = subscriptionVendorForRef(ref)
    // Not a subscription ref, or its harness isn't enabled inline → the inner provider decides.
    if (!vendor || !this.deps.inlineHarnesses.includes(SUBSCRIPTION_VENDORS[vendor].harness)) {
      return this.inner.resolve(ref)
    }
    // Prefer the developer's OWN host CLI for a native ambient vendor when it's installed:
    // unmetered, ambient login, no lease. Requires the harness be in the ambient allow-list too
    // (that's what `isAmbientNativeVendor` + presence check together give).
    const nativeVendor = nativeVendorForRef(ref)
    if (
      nativeVendor &&
      this.deps.hostCliVendors.has(nativeVendor) &&
      isAmbientNativeVendor(this.deps.inlineHarnesses, nativeVendor)
    ) {
      return new CliInlineLanguageModel(
        ref.provider,
        ref.model,
        runnerForVendor(nativeVendor, this.deps.exec ?? spawnCliExec, this.deps.cliBudget ?? {}),
        ...this.telemetry(),
      )
    }
    // Otherwise run it in a warm container on a leased credential (the compatibility path — no
    // host CLI needed, works in mothership mode; serves non-native vendors too).
    return new CliInlineLanguageModel(
      ref.provider,
      ref.model,
      makeContainerRunner(vendor, ref, this.scope, this.deps),
      ...this.telemetry(),
    )
  }

  /**
   * The per-call telemetry both transports file through, or nothing when the facade retains no
   * metrics (in which case the model leaves its rows to the instrumentation middleware).
   *
   * The SCOPE is what makes attribution work without a per-call tag: this provider is built per
   * `ModelScope`, so the run and workspace are already resolved here — which is the same fallback
   * the middleware applies, through the same `resolveInlineAttribution`.
   *
   * A spread-able tuple rather than a nullable argument so the two construction sites cannot
   * disagree about whether telemetry is wired.
   */
  private telemetry(): [InlineCliTelemetry] | [] {
    if (!this.deps.recordInlineCall) return []
    return [
      {
        recordCall: this.deps.recordInlineCall,
        scope: {
          workspaceId: this.scope.workspaceId,
          ...(this.scope.executionId ? { executionId: this.scope.executionId } : {}),
        },
        recordBodies: this.deps.recordInlineBodies ?? false,
        logger,
      },
    ]
  }
}

/**
 * Wrap the Node model-provider resolver so a resolved provider serves enabled subscription
 * harness refs inline: the developer's host `claude`/`codex` CLI when present, else a warm
 * container on the LEASED subscription credential (personal per-run activation for an individual
 * vendor, pooled token otherwise). Passed to `buildNodeContainer` as `wrapModelProviderResolver`
 * in local mode; a no-op when no inline harnesses are enabled (`LOCAL_NATIVE_INLINE=off`). The
 * lease seams (`leasePersonalSubscriptionToken`/`leaseSubscriptionToken`) are supplied by
 * `buildNodeContainer` (built from the same subscription services the container executor uses).
 *
 * This wrap SUBSTITUTES the model rather than delegating for a subscription ref, so it must stay
 * BENEATH the telemetry wrap — `buildNodeModelDeps` applies
 * `wrapResolverWithInstrumentation` on top of it, and reversing that (the shape this facade
 * shipped with) makes every call served here invisible to `llm_call_metrics` while every other
 * inline call keeps recording, which is the hardest possible version of this bug to notice.
 */
export function wrapResolverWithInlineHarness(
  deps: InlineHarnessResolverDeps,
): (inner: ModelProviderResolver) => ModelProviderResolver {
  return (inner) => ({
    async forScope(scope: ModelScope): Promise<ModelProvider> {
      const provider = await inner.forScope(scope)
      if (deps.inlineHarnesses.length === 0) return provider
      return new SubscriptionInlineModelProvider(provider, scope, deps)
    },
  })
}
