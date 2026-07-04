import { execFile } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { ComposeRuntime } from '@cat-factory/integrations'

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
  return {
    async compose(args, options) {
      try {
        const { stdout, stderr } = await execFileAsync(binary, ['compose', ...args], {
          maxBuffer: MAX_BUFFER,
          timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          env: options?.env ? { ...process.env, ...options.env } : process.env,
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
      const path = join(projectDir(project), 'checkout', relPath)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf8')
      return path
    },
    async cleanupProject(project) {
      await rm(projectDir(project), { recursive: true, force: true }).catch(() => {})
    },
  }
}
