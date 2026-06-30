import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ComposeRuntime } from '@cat-factory/integrations'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 16 * 1024 * 1024
// Fallback bound when the provider passes no `timeoutMs`, so a wedged daemon can't hang forever.
const DEFAULT_TIMEOUT_MS = 60_000

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
    async cleanupProject(project) {
      await rm(projectDir(project), { recursive: true, force: true }).catch(() => {})
    },
  }
}
