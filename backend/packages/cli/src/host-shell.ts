import { spawn } from 'node:child_process'

/**
 * The result of running a host command. `code` is the process exit code; the special value
 * {@link COMMAND_NOT_FOUND} (127) is used when the binary itself is missing (spawn `ENOENT`),
 * so callers can distinguish "not installed" from "ran but failed".
 */
export interface ShellResult {
  code: number
  stdout: string
  stderr: string
}

/** Conventional exit code for a missing binary — returned by {@link HostShell.run} on `ENOENT`. */
export const COMMAND_NOT_FOUND = 127

/**
 * A single command to run through the {@link HostShell}, optionally with stdin `input`.
 *
 * Lives here rather than beside one of its planners because several modules now plan commands
 * (provisioning, the ingress probe) and a shared type in either of them would make the pair
 * import each other.
 */
export interface Command {
  cmd: string
  args: string[]
  input?: string
  /** Per-command watchdog override (ms). Absent ⇒ the {@link HostShell} default applies. */
  timeoutMs?: number
}

/** Conventional exit code for a command killed by the watchdog timeout (mirrors `timeout(1)`). */
export const COMMAND_TIMED_OUT = 124

/**
 * Default per-command watchdog (ms). A probe must stay responsive, but some detections shell out to
 * `kubectl`, which contacts the apiserver — a kubeconfig pointing at a down/unroutable cluster would
 * otherwise block on the TCP/HTTP timeout. The watchdog kills such a child and reports
 * {@link COMMAND_TIMED_OUT} so the probe treats it as "ran but failed" (not reachable), never hangs.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000

/**
 * Host shell-out seam. The k3s flow depends on this interface (never on `node:child_process`
 * directly), so probing/provisioning can be driven by a fake in tests. The real implementation
 * ({@link createNodeShell}) spawns real processes; tests inject their own. Mirrors the `Io` /
 * `FileSystem` seams used by the `init` command.
 */
export interface HostShell {
  /**
   * Run `cmd` with `args`, capturing stdout/stderr. Resolves with the exit code — it NEVER
   * rejects: a missing binary resolves to `{ code: COMMAND_NOT_FOUND }` so the probe can treat
   * "not installed" uniformly, and a command that overruns `timeoutMs` is killed and resolves to
   * `{ code: COMMAND_TIMED_OUT }`. Output is returned to the caller, never logged here.
   *
   * `opts.input`, when set, is written to the child's stdin and the stream is closed — used to
   * feed a manifest to `kubectl apply -f -` WITHOUT writing it (or the token Secret it creates)
   * to a temp file on disk.
   *
   * `opts.cwd` runs the command from a specific directory. Required by anything that shells out to
   * a directory-sensitive tool: `docker compose` resolves its `docker-compose.yml` relative to the
   * working directory, so a supervisor launched from elsewhere would silently operate on no
   * compose project at all.
   */
  run(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; input?: string; cwd?: string },
  ): Promise<ShellResult>
}

/**
 * Run a planned {@link Command} through a shell, honouring every field it carries.
 *
 * Use this for a READ whose non-zero exit is data rather than a failure (a probe, a best-effort
 * list). `shell.run(command.cmd, command.args)` at a call site looks equivalent and is not: it
 * silently drops `input` and the per-command `timeoutMs`, and hard-codes the binary the planner
 * was there to name, so changing `cmd` keeps invoking the old one and the read gets the 10s
 * default watchdog instead of its own.
 */
export function runCommand(shell: HostShell, command: Command): Promise<ShellResult> {
  return shell.run(command.cmd, command.args, {
    input: command.input,
    timeoutMs: command.timeoutMs,
  })
}

/** A planned command rendered as the shell line a human would type, for printed guidance. */
export function renderCommandLine(command: Command): string {
  return [command.cmd, ...command.args].join(' ')
}

/** The real, process-backed {@link HostShell}. */
export function createNodeShell(): HostShell {
  return {
    run(cmd, args, opts) {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
      return new Promise<ShellResult>((resolve) => {
        let stdout = ''
        let stderr = ''
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (result: ShellResult): void => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          resolve(result)
        }

        // Feed stdin only when there's input; otherwise leave it closed (`ignore`).
        const stdin = opts?.input !== undefined ? 'pipe' : 'ignore'
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(cmd, args, { cwd: opts?.cwd, stdio: [stdin, 'pipe', 'pipe'] })
        } catch {
          finish({ code: COMMAND_NOT_FOUND, stdout: '', stderr: `${cmd}: not found` })
          return
        }

        if (opts?.input !== undefined && child.stdin) {
          // A child that exits before draining stdin raises EPIPE on the write; swallow it so a
          // fast-failing command surfaces as its exit code, not an unhandled stream error.
          child.stdin.on('error', () => {})
          child.stdin.end(opts.input)
        }

        // Watchdog: kill a child that runs past the deadline (e.g. `kubectl` stuck dialing an
        // unreachable apiserver) and report it as timed-out rather than blocking the probe forever.
        timer = setTimeout(() => {
          child.kill('SIGKILL')
          finish({ code: COMMAND_TIMED_OUT, stdout, stderr: stderr || `${cmd}: timed out` })
        }, timeoutMs)
        timer.unref?.()

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        child.on('error', (err: NodeJS.ErrnoException) => {
          // ENOENT ⇒ the binary is missing; anything else ⇒ a genuine spawn failure. Both are
          // surfaced as a non-zero result rather than a throw so the caller stays branch-free.
          const code = err.code === 'ENOENT' ? COMMAND_NOT_FOUND : 1
          finish({ code, stdout, stderr: stderr || err.message })
        })
        child.on('close', (code) => {
          finish({ code: code ?? 1, stdout, stderr })
        })
      })
    },
  }
}
