import { spawn } from 'node:child_process'
import { killChildProcess, spawnDetached } from './process.js'
import { MAX_CAPTURED_OUTPUT_CHARS, redactSecrets } from './redact.js'
import type { RunOptions } from './runner.js'
import type { Logger } from './logger.js'

// The ONE way the harness runs a declared shell command on its own behalf (rather than through
// the agent) and keeps a bounded, secret-scrubbed record of what it printed.
//
// Both pre-PR verification phases need exactly this — the PRE-PR VALIDATION checks
// (`validation-checks.ts`) and the BUGFIX REPRODUCTION PROOF (`reproduction-proof.ts`) — and they
// need it to behave IDENTICALLY: same watchdog semantics, same abort handling, same conventional
// exit codes, same scrub-then-bound pipeline. They were two near-verbatim copies; a fix applied to
// one of them (a redaction ordering, an exit-code convention) silently missed the other, which is
// the whole reason this seam exists.
//
// Everything is PER-JOB by construction: the command, the cwd and the environment all arrive as
// arguments and nothing is read from or written to `process.env`/`HOME`. The local NATIVE
// transport serves every concurrent job from ONE host process, so a global would leak one job's
// state into a sibling's — and the container path would never catch it.

/**
 * A little slack kept in the rolling capture buffer ON TOP of {@link MAX_CAPTURED_OUTPUT_CHARS},
 * so scrubbing sees whole secrets.
 *
 * The buffer discards from the FRONT as output arrives, and `redactSecrets` only runs once the
 * command settles. Without the margin a token straddling that rolling cut would already have lost
 * its `KEY=` prefix by scrub time and would survive as an unrecognised partial. Capturing a bit
 * more than we keep, scrubbing, and only THEN bounding to the real limit closes that window; 512
 * chars comfortably exceeds any single credential assignment the rules match.
 */
const CAPTURE_MARGIN_CHARS = 512

/** What one harness-spawned command did, as both phases record it. */
export interface CapturedCommandResult {
  /** Exit code (0 = pass); 124 on watchdog timeout, 127 on spawn failure, 130 on abort. */
  exitCode: number
  passed: boolean
  /** Scrubbed output bounded to the caller's REPORT budget (what crosses the wire). */
  outputTail?: string
  durationMs: number
  timedOut?: boolean
  /**
   * The FULL scrubbed tail (up to {@link MAX_CAPTURED_OUTPUT_CHARS}) for a repair prompt. Never
   * leaves the container — the agent needs the whole failure to act on it, the wire does not.
   */
  fullTail?: string
}

/**
 * Run ONE command as `sh -c` in `cwd`, capturing a bounded, secret-scrubbed tail of its combined
 * stdout+stderr. The exit code is the verdict — computed here by the harness, never self-reported
 * by the model, which is the whole point of a programmatic phase. A watchdog kills the process
 * tree on timeout and an aborted run resolves non-zero, so a phase is never what blocks a job
 * from settling.
 *
 * The child inherits the JOB's environment (`RunOptions.agentEnv` layered over the process env),
 * not a mutated global: the harness spawns this itself rather than through the agent, so without
 * the explicit merge a native-mode job would run without the private-registry npmrc pointer (and,
 * had this been staged in `process.env`, against a sibling job's state).
 *
 * `logLabel`/`logFields` shape only the two warnings this runner emits itself (the watchdog kill
 * and a spawn failure); the caller keeps its own start/finish logging, which knows what the
 * command MEANS.
 */
export async function runCapturedCommand(args: {
  cwd: string
  command: string
  timeoutMs: number
  /** Bound for {@link CapturedCommandResult.outputTail} — the caller's per-report budget. */
  reportTailChars: number
  logLabel: string
  logFields?: Record<string, unknown>
  logger: Logger
  opts: RunOptions
}): Promise<CapturedCommandResult> {
  const { cwd, command, timeoutMs, reportTailChars, logLabel, logFields, logger, opts } = args
  const startedAt = Date.now()
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    let timedOut = false
    const child = spawn('sh', ['-c', command], {
      cwd,
      detached: spawnDetached,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.agentEnv },
    })
    // Keep only the tail (plus the scrub margin); guard against unbounded buffering on a chatty
    // command.
    const capture = (chunk: Buffer): void => {
      out = (out + chunk.toString('utf8')).slice(
        -(MAX_CAPTURED_OUTPUT_CHARS + CAPTURE_MARGIN_CHARS),
      )
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      const trimmed = out.trim()
      // Scrub BEFORE either bound: the pattern rules need a whole assignment to match, so the
      // margin above is trimmed away only once the secrets are already gone.
      const scrubbed = trimmed ? redactSecrets(trimmed).slice(-MAX_CAPTURED_OUTPUT_CHARS) : ''
      resolve({
        exitCode,
        passed: exitCode === 0,
        ...(scrubbed ? { outputTail: boundTail(scrubbed, reportTailChars) } : {}),
        durationMs: Date.now() - startedAt,
        ...(timedOut ? { timedOut: true } : {}),
        ...(scrubbed ? { fullTail: scrubbed } : {}),
      })
    }
    const timer = setTimeout(() => {
      logger.warn(`${logLabel}: command timed out`, { ...logFields, timeoutMs })
      timedOut = true
      killChildProcess(child, undefined, logger)
      finish(124) // conventional timeout exit code (a non-zero fail)
    }, timeoutMs)
    timer.unref?.()
    const onAbort = (): void => {
      killChildProcess(child, undefined, logger)
      finish(130) // aborted (a non-zero fail)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => {
      logger.warn(`${logLabel}: command failed to spawn`, {
        ...logFields,
        error: err instanceof Error ? err.message : String(err),
      })
      finish(127) // spawn error / command not found (a non-zero fail)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
}

/**
 * Wrap captured command output in a fenced block that the output itself cannot break out of.
 *
 * Every consumer of a captured tail embeds it in markdown a MODEL then reads — a repair prompt,
 * the dependency-install note — and a package manager legitimately prints backticks (a linter
 * quoting a template literal, a test echoing a fenced snippet from a fixture). A fixed three-tick
 * fence closes on the first such run, and everything after it reads as prose: the remaining
 * output, and worse, the INSTRUCTIONS that follow the block. Sizing the fence one tick longer than
 * the longest run in the body is what CommonMark specifies for exactly this, so the block always
 * spans the whole tail.
 *
 * A deliberate COPY of kernel's `fencedBlock` (the container image builds from `src/` plus
 * typescript alone, so the harness can depend on no workspace package), pinned byte-for-byte by
 * `test/fenced-block.conformity.test.ts` — the same arrangement `src/host-markdown.ts` has.
 * Changing one means changing the other.
 */
export function fencedOutput(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}\n${text}\n${fence}`
}

/** Bound an already-scrubbed output tail to what a REPORT carries, saying what it dropped. */
export function boundTail(scrubbed: string, maxChars: number): string {
  if (scrubbed.length <= maxChars) return scrubbed
  const trimmed = scrubbed.length - maxChars
  return `…(${trimmed} earlier chars trimmed)\n${scrubbed.slice(-maxChars)}`
}
