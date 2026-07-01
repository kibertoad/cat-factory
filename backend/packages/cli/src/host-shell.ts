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
 * Host shell-out seam. The k3s flow depends on this interface (never on `node:child_process`
 * directly), so probing/provisioning can be driven by a fake in tests. The real implementation
 * ({@link createNodeShell}) spawns real processes; tests inject their own. Mirrors the `Io` /
 * `FileSystem` seams used by the `init` command.
 */
export interface HostShell {
  /**
   * Run `cmd` with `args`, capturing stdout/stderr. Resolves with the exit code — it NEVER
   * rejects: a missing binary resolves to `{ code: COMMAND_NOT_FOUND }` so the probe can treat
   * "not installed" uniformly. Output is returned to the caller, never logged here.
   */
  run(cmd: string, args: string[]): Promise<ShellResult>
}

/** The real, process-backed {@link HostShell}. */
export function createNodeShell(): HostShell {
  return {
    run(cmd, args) {
      return new Promise<ShellResult>((resolve) => {
        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (result: ShellResult): void => {
          if (settled) return
          settled = true
          resolve(result)
        }

        let child: ReturnType<typeof spawn>
        try {
          child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        } catch {
          finish({ code: COMMAND_NOT_FOUND, stdout: '', stderr: `${cmd}: not found` })
          return
        }

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
