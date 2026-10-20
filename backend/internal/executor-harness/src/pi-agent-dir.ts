import { copyFile, mkdtemp, rm, stat, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// Pi's config directory, made PER JOB. Pi reads everything the harness hands it from one directory
// (the provider config, the composed AGENTS.md, the tool-server config) and writes its own run
// state there too (auth, sessions, trust). `PI_CODING_AGENT_DIR` points one Pi process at any
// directory, so each pass gets its own and nothing the harness stages for a job is ever written to a
// HOME-global path (the executor README's per-job-state rule).
//
// That also retires a lifecycle the global directory forced: a warm-pool container reuses its home,
// so a file one job wrote had to be actively cleared by the next or it would start the previous
// job's tool servers. A directory that is created for the pass and removed after it has nothing to
// clear, and a file in it is always freshly created, so its mode is always the one it was written
// with.

/**
 * The image's own Pi config directory. Only READ, as the seed of a per-job directory: it is where
 * the Dockerfile's `pi install` put the image's extensions. Nothing a job stages is written here.
 */
export function piImageAgentDir(): string {
  return join(homedir(), '.pi', 'agent')
}

/**
 * What a per-job directory takes from the seed. The extensions `pi install` baked into the image
 * are the package directories (`npm/`, `git/`), which Pi resolves under whichever config directory
 * it runs against, and the `settings.json` listing them. The packages are linked (read-only in
 * practice and large); the settings are COPIED, because Pi writes its settings file and a link
 * would carry one job's writes into the image's copy and on to every later job.
 *
 * Deliberately an allow-list. Everything else in the seed is Pi's own run state (`auth.json`,
 * `sessions/`, `trust.json`, MCP sign-ins), which is exactly what must NOT cross from one job to
 * the next.
 */
const LINKED_ENTRIES = ['npm', 'git'] as const
const COPIED_ENTRIES = ['settings.json'] as const

/** One pass's Pi config directory. {@link dispose} removes it and everything in it. */
export interface PiAgentDir {
  readonly path: string
  dispose(): Promise<void>
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

/**
 * Create a fresh, owner-only Pi config directory for one pass. With `seedFrom`, the image's
 * installed extensions are carried over (see {@link LINKED_ENTRIES}); without it the directory
 * starts empty, which is what an embedder running on a developer's machine wants, since seeding
 * from there would hand the run the developer's personal Pi setup.
 *
 * Owner-only because the tool-server config written into it carries the job's resolved
 * credentials (`mkdtemp` creates the directory `0700`).
 */
export async function createPiAgentDir(opts: { seedFrom?: string } = {}): Promise<PiAgentDir> {
  const path = await mkdtemp(join(tmpdir(), 'cf-pi-agent-'))
  const dispose = () => rm(path, { recursive: true, force: true })
  try {
    if (opts.seedFrom) {
      const seed = opts.seedFrom
      for (const entry of LINKED_ENTRIES) {
        if (await exists(join(seed, entry))) await symlink(join(seed, entry), join(path, entry))
      }
      for (const entry of COPIED_ENTRIES) {
        if (await exists(join(seed, entry))) await copyFile(join(seed, entry), join(path, entry))
      }
    }
  } catch (error) {
    await dispose()
    throw error
  }
  return { path, dispose }
}

/**
 * Run `fn` against a fresh Pi config directory and remove it afterwards, whatever `fn` did: the
 * directory holds this job's credentials, so it must not outlive the pass on the failure path.
 */
export async function withPiAgentDir<T>(
  opts: { seedFrom?: string },
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await createPiAgentDir(opts)
  try {
    return await fn(dir.path)
  } finally {
    await dir.dispose()
  }
}
