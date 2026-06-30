import { execFile } from 'node:child_process'
import { redact } from './redact.js'
import { killChildProcess } from './process.js'
import type { Logger } from './logger.js'

// One place to shell out to a CLI (git / kubectl / kustomize / helm). The job
// watchdog's AbortSignal and a per-command wall-clock both bound a wedged process, so
// neither a hung apply nor a stalled helm install can keep the container running
// forever. stdout+stderr are captured; on failure the combined output is scrubbed of
// credentials (the apiserver token, the git token, any resolved secret value the job
// carried) before it is surfaced.

/** Per-command wall-clock ceiling. The job's overall watchdog (runner.ts) is the outer bound. */
const COMMAND_TIMEOUT_MS = 8 * 60_000
const MAX_BUFFER = 16 * 1024 * 1024

export interface RunCliOptions {
  cwd?: string
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  /** Secret strings to scrub from any surfaced error/output. */
  redactSecrets?: readonly string[]
  /** stdin to pipe in (e.g. a manifest applied via `kubectl apply -f -`). */
  input?: string
  /** Per-job logger; the failing command is logged at debug with its (redacted) output. */
  log?: Logger
  /** Override the per-command timeout. */
  timeoutMs?: number
}

export interface CliResult {
  stdout: string
  stderr: string
}

/**
 * Run `cmd args`, resolving with captured stdout/stderr. A non-zero exit throws an Error
 * whose message names the command + its redacted combined output, so a kubectl/helm
 * failure surfaces its real reason on the job view rather than a bare exit code.
 */
export async function runCli(
  cmd: string,
  args: string[],
  opts: RunCliOptions = {},
): Promise<CliResult> {
  const secrets = opts.redactSecrets ?? []
  return await new Promise<CliResult>((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        maxBuffer: MAX_BUFFER,
        timeout: opts.timeoutMs ?? COMMAND_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        // execFile defaults to utf8 string output (no `encoding: 'buffer'` set above).
        const out = stdout
        const err = stderr
        if (error) {
          const combined = redact(`${err}\n${out}`.trim(), secrets)
          opts.log?.debug('cli command failed', { cmd, redactedOutput: combined })
          const message = redact(
            `${cmd} ${redact(args.join(' '), secrets)} failed: ${combined || error.message}`,
            secrets,
          )
          reject(new Error(message))
          return
        }
        resolve({ stdout: out, stderr: err })
      },
    )
    // Tie the child to the job watchdog: an abort SIGTERM→SIGKILLs it (execFile's own
    // `signal` option only sends one signal, so do the escalation ourselves).
    if (opts.signal) {
      if (opts.signal.aborted) killChildProcess(child)
      else opts.signal.addEventListener('abort', () => killChildProcess(child), { once: true })
    }
    if (opts.input !== undefined && child.stdin) {
      // Writing the manifest into stdin can hit a broken pipe (the child already exited,
      // spawn failed with ENOENT, or we just SIGTERM'd it on an aborted signal above).
      // Swallow the resulting 'error' event so an EPIPE can't surface as an
      // uncaughtException and tear down the whole container — the execFile callback still
      // rejects with the real failure.
      child.stdin.on('error', () => {})
      child.stdin.end(opts.input)
    }
  })
}
