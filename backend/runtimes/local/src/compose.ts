import { execFile, spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { ComposeExecResult, ComposeRuntime } from '@cat-factory/integrations'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 16 * 1024 * 1024
// Fallback bound when the provider passes no `timeoutMs`, so a wedged daemon can't hang forever.
const DEFAULT_TIMEOUT_MS = 60_000
// Bound for the git clone in build mode (a shallow single-ref fetch is fast; guard a wedged remote).
const CLONE_TIMEOUT_MS = 120_000

// The local-mode host implementation of the integrations `ComposeRuntime` seam: run
// `docker compose <args>` via `execFile` (bounded by `timeoutMs`) and persist each project's
// rewritten compose file under a host temp dir the daemon can read. This is the only place the
// Docker-Compose environment backend touches `node:*`, keeping the integrations provider
// runtime-neutral.

export interface DockerComposeRuntimeOptions {
  /** The docker-family CLI binary (default `docker`; honours `LOCAL_DOCKER_BINARY`). */
  binary?: string
  /** Base dir for per-project scratch files (default `<tmp>/cat-factory-compose`). */
  scratchRoot?: string
}

export function createDockerComposeRuntime(opts: DockerComposeRuntimeOptions = {}): ComposeRuntime {
  const binary = opts.binary?.trim() || 'docker'
  const scratchRoot = opts.scratchRoot || join(tmpdir(), 'cat-factory-compose')
  const projectDir = (project: string) => join(scratchRoot, project)
  const checkoutDir = (project: string) => join(projectDir(project), 'checkout')
  return {
    async compose(args, options) {
      const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const env = options?.env ? { ...process.env, ...options.env } : process.env
      // A `compose-exec` recipe step may stream a repo-relative checkout file into the command's
      // stdin (a `.sql` seed dump piped to a db client). `execFile` can't feed a stream to stdin, so
      // spawn + pipe the file for that case; everything else stays on the simpler execFile path.
      if (options?.stdin) {
        const filePath = join(checkoutDir(options.stdin.project), options.stdin.checkoutFile)
        return runComposeWithStdin(binary, args, filePath, { env, timeoutMs: timeout })
      }
      try {
        const { stdout, stderr } = await execFileAsync(binary, ['compose', ...args], {
          maxBuffer: MAX_BUFFER,
          timeout,
          env,
        })
        return { code: 0, stdout, stderr }
      } catch (err) {
        // A non-zero exit rejects with `.code` = the exit code (a number) plus the captured
        // streams; a missing binary rejects with `.code` = 'ENOENT' (a string); a timeout rejects
        // with `.killed` = true (and SIGTERM). Normalize all three into a non-throwing result so
        // the provider can surface the daemon's complaint as `step.environment.lastError` instead
        // of a generic 500.
        const e = err as {
          code?: number | string
          killed?: boolean
          stdout?: string
          stderr?: string
          message?: string
        }
        const code = typeof e.code === 'number' ? e.code : 1
        const timedOut = e.killed
          ? `docker compose timed out after ${options?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
          : undefined
        return { code, stdout: e.stdout ?? '', stderr: e.stderr || timedOut || e.message || '' }
      }
    },
    async writeProjectFile(project, fileName, content) {
      const dir = projectDir(project)
      await mkdir(dir, { recursive: true })
      const path = join(dir, fileName)
      await writeFile(path, content, 'utf8')
      return path
    },
    async checkout(project, target) {
      // Build mode: shallow-clone the PR head into a working tree UNDER the project scratch dir
      // (so the existing `cleanupProject` reaps it on teardown). Mirrors the deploy-harness clone:
      // init + `fetch --depth 1 origin <ref>` + detached checkout (so a raw SHA ref works too), and
      // the token is passed to git via GIT_ASKPASS — never on argv.
      const dir = join(projectDir(project), 'checkout')
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      await mkdir(dir, { recursive: true })
      // Embed only the `x-access-token` username (no secret) in the remote URL.
      const authUrl = target.cloneUrl.replace(/^https:\/\//, 'https://x-access-token@')
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' } as Record<string, string>
      if (target.token) {
        const askpass = join(projectDir(project), 'git-askpass.sh')
        await writeFile(askpass, '#!/bin/sh\nexec printf %s "$GIT_ASKPASS_TOKEN"\n', 'utf8')
        await chmod(askpass, 0o700)
        env.GIT_ASKPASS = askpass
        env.GIT_ASKPASS_TOKEN = target.token
      }
      const git = async (args: string[]) => {
        try {
          await execFileAsync('git', args, {
            maxBuffer: MAX_BUFFER,
            timeout: CLONE_TIMEOUT_MS,
            env,
          })
        } catch (err) {
          const e = err as { stderr?: string; message?: string }
          // Redact the token from any surfaced message (defensive — it's not on argv, but be safe).
          const raw = (e.stderr || e.message || 'git failed').trim()
          const msg = target.token ? raw.split(target.token).join('***') : raw
          throw new Error(msg)
        }
      }
      await git(['init', '--quiet', dir])
      await git(['-C', dir, 'remote', 'add', 'origin', authUrl])
      await git(['-C', dir, 'fetch', '--depth', '1', 'origin', target.ref])
      await git(['-C', dir, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'])
      return { dir }
    },
    async writeCheckoutFile(project, relPath, content) {
      const path = join(checkoutDir(project), relPath)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf8')
      return path
    },
    async copyCheckoutFile(project, from, to) {
      // Recipe env-file materialization / `copy-file` steps: copy a committed template to its
      // gitignored target INSIDE the checkout. Both paths are repo-relative and were host-escape
      // guarded by the provider before we get here.
      const dst = join(checkoutDir(project), to)
      await mkdir(dirname(dst), { recursive: true })
      await copyFile(join(checkoutDir(project), from), dst)
    },
    async checkoutFileExists(project, relPath) {
      try {
        await stat(join(checkoutDir(project), relPath))
        return true
      } catch {
        return false
      }
    },
    async hostCommand(project, argv, options) {
      // A recipe `host-command` step: run an arbitrary argv on the HOST (opt-in, provider-gated),
      // cwd at the checkout (+ optional in-checkout `workdir`). Normalize failures/timeouts into a
      // non-throwing result exactly like `compose`, so the provider surfaces the step's own error.
      const cwd = options?.workdir
        ? join(checkoutDir(project), options.workdir)
        : checkoutDir(project)
      const [command, ...rest] = argv
      try {
        const { stdout, stderr } = await execFileAsync(command!, rest, {
          cwd,
          maxBuffer: MAX_BUFFER,
          timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          env: options?.env ? { ...process.env, ...options.env } : process.env,
        })
        return { code: 0, stdout, stderr }
      } catch (err) {
        const e = err as {
          code?: number | string
          killed?: boolean
          stdout?: string
          stderr?: string
          message?: string
        }
        const code = typeof e.code === 'number' ? e.code : 1
        const timedOut = e.killed
          ? `host command timed out after ${options?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
          : undefined
        return { code, stdout: e.stdout ?? '', stderr: e.stderr || timedOut || e.message || '' }
      }
    },
    async ensureNetwork(name) {
      // Shared-stack bring-up: idempotently ensure a managed Docker network exists so consumers can
      // attach to it as `external: true`. `network inspect` succeeds when present (a no-op create);
      // otherwise `network create`. Normalize failures into a non-throwing result like `compose`.
      try {
        await execFileAsync(binary, ['network', 'inspect', name], {
          maxBuffer: MAX_BUFFER,
          timeout: DEFAULT_TIMEOUT_MS,
        })
        return { code: 0, stdout: '', stderr: '' }
      } catch {
        // Not present (or unreachable) — try to create it.
      }
      try {
        const { stdout, stderr } = await execFileAsync(binary, ['network', 'create', name], {
          maxBuffer: MAX_BUFFER,
          timeout: DEFAULT_TIMEOUT_MS,
        })
        return { code: 0, stdout, stderr }
      } catch (err) {
        const e = err as {
          code?: number | string
          stdout?: string
          stderr?: string
          message?: string
        }
        const code = typeof e.code === 'number' ? e.code : 1
        return { code, stdout: e.stdout ?? '', stderr: e.stderr || e.message || '' }
      }
    },
    async cleanupProject(project) {
      await rm(projectDir(project), { recursive: true, force: true }).catch(() => {})
    },
  }
}

/**
 * Run `docker compose <args>` streaming a host file into the command's stdin (a recipe
 * `compose-exec` seed import). `execFile` has no stdin-stream option, so spawn the child, pipe the
 * file, bound the output buffers + a kill timeout, and normalize the outcome into a non-throwing
 * {@link ComposeExecResult} — matching the `compose` error posture. A missing/unreadable stdin file
 * fails the step with a clear message rather than silently feeding an empty stream to the command.
 */
function runComposeWithStdin(
  binary: string,
  args: string[],
  filePath: string,
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ComposeExecResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['compose', ...args], { env: opts.env })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: ComposeExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({
        code: 1,
        stdout,
        stderr: stderr || `docker compose timed out after ${opts.timeoutMs}ms`,
      })
    }, opts.timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_BUFFER) stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_BUFFER) stderr += d.toString()
    })
    child.on('error', (err) => finish({ code: 1, stdout, stderr: stderr || String(err) }))
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }))
    const rs = createReadStream(filePath)
    rs.on('error', (err) => {
      child.kill('SIGTERM')
      finish({ code: 1, stdout, stderr: `could not read stdin file '${filePath}': ${String(err)}` })
    })
    // The child can exit before stdin is fully written (an early auth/syntax failure, or the
    // SIGTERM on timeout); the still-writing pipe then emits EPIPE on `child.stdin`. Without a
    // handler that is an unhandled 'error' that crashes the whole process, so swallow it and stop
    // the source — the child's own exit code + stderr (via 'close'/'error') is the real outcome.
    child.stdin.on('error', () => rs.destroy())
    rs.pipe(child.stdin)
  })
}
