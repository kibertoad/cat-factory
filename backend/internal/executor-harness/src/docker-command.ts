import { spawn } from 'node:child_process'
import { log, type Logger } from './logger.js'
import { killChildProcess, spawnDetached } from './process.js'

// ---------------------------------------------------------------------------
// How the harness runs one `docker …` command ON ITS OWN BEHALF, bounded and abortable.
//
// This is NOT a second `runCapturedCommand` (captured-command.ts), which stays the one way the
// harness runs a DECLARED shell command: that one takes a shell string, merges both streams into
// one rolling tail and answers with a conventional exit code, because its two callers report a
// pass/fail plus a tail to a model. The docker checks need the three things it deliberately does
// not offer: an argv (no shell, so nothing quotes an image tag), a STDIN body (the probe archive
// is piped to `docker load`), and stdout kept APART from stderr, since the whole evidence that a
// container ran is a marker on stdout while the evidence of why it did not is on stderr.
//
// What it does NOT re-decide is how a child dies: `killChildProcess` owns the SIGTERM→SIGKILL
// escalation for every process this harness spawns, and a bespoke `SIGKILL` here would be one
// path whose kill semantics drift from the rest with no test able to see it.
// ---------------------------------------------------------------------------

/** How much of each stream is buffered. The TAIL is kept: that is where a failure prints. */
const OUTPUT_CAP_CHARS = 64 * 1024

/** What running one docker command did, kept as raw as the spawn. */
export type CommandOutcome =
  | { outcome: 'ran'; code: number; stdout: string; stderr: string }
  | { outcome: 'failed'; reason: string }

/** What one docker invocation is given. `timeoutMs` is required: an unbounded one has no caller. */
export interface DockerCommandOptions {
  /** Piped to the command's stdin and closed. */
  stdin?: Buffer
  /** The job's signal. An abandoned job's command is killed rather than left running. */
  signal?: AbortSignal
  timeoutMs: number
  logger?: Logger
}

/** Run one `docker …` command. Injected so the suite drives every branch with no daemon. */
export type DockerCommandRunner = (
  args: string[],
  opts: DockerCommandOptions,
) => Promise<CommandOutcome>

/**
 * The real runner: spawn docker, feed it `stdin` when there is any, and report what happened.
 *
 * Never rejects. Every way a spawn can go wrong is one of the two outcomes, because the caller
 * classifies them differently and an exception would collapse that distinction into whichever
 * `catch` caught it first.
 */
export const spawnDockerCommand: DockerCommandRunner = (args, opts) =>
  new Promise<CommandOutcome>((resolve) => {
    const logger = opts.logger ?? log
    if (opts.signal?.aborted) {
      resolve({ outcome: 'failed', reason: abandonedReason(args) })
      return
    }
    const child = spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: spawnDetached,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: CommandOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const timer = setTimeout(() => {
      logger.warn('docker: command did not answer in time, killing it', {
        command: args[0] ?? '',
        timeoutMs: opts.timeoutMs,
      })
      killChildProcess(child, undefined, logger)
      finish({
        outcome: 'failed',
        reason: `\`docker ${args[0] ?? ''}\` did not answer within ${Math.round(opts.timeoutMs / 1000)}s`,
      })
    }, opts.timeoutMs)
    timer.unref?.()
    const onAbort = (): void => {
      killChildProcess(child, undefined, logger)
      finish({ outcome: 'failed', reason: abandonedReason(args) })
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    // The tail, not the head: a `docker run` that failed says why in its last lines, and the
    // marker a passing one prints is the whole of its output anyway.
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-OUTPUT_CAP_CHARS)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-OUTPUT_CAP_CHARS)
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({
        outcome: 'failed',
        reason:
          err.code === 'ENOENT'
            ? 'the docker CLI is not on PATH'
            : `the docker CLI could not be spawned (${err.code ?? err.message})`,
      })
    })
    child.on('close', (code) => finish({ outcome: 'ran', code: code ?? -1, stdout, stderr }))
    // A daemon that dies mid-load closes the pipe under us; `close` above already reports that,
    // so the EPIPE here has nothing to add and must not become an unhandled error event.
    child.stdin.on('error', () => {})
    child.stdin.end(opts.stdin)
  })

function abandonedReason(args: string[]): string {
  return `the job was cancelled before \`docker ${args[0] ?? ''}\` answered`
}
