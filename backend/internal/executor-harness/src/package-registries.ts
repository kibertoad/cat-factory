import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PackageRegistrySpec } from './job.js'
import { registerKnownSecrets } from './redact.js'

// Private package-registry auth for the checkout's installs (npm private orgs,
// GitHub Packages). The job's allowlisted entries are rendered into an npmrc — read by
// npm, pnpm and yarn v1 alike, and inherited by every child process (the agent's own
// shell installs and the frontend-infra stand-up's) — so the token never rides argv or
// the checkout.
//
// WHERE that npmrc lands depends on whether the harness process owns its HOME:
//   - container (the default): the user `~/.npmrc`. HOME belongs to that one container, so
//     writing it is safe and a job with NO entries CLEARS it — warm-pool containers are
//     reused across jobs and must not leak a prior workspace's token.
//   - shared native host process (`ambientAuth`, the local native transport): HOME is the
//     DEVELOPER's. Writing there would overwrite their own npm config, clearing there would
//     DELETE it, and concurrent jobs in the one process would race on the single file. Such a
//     job gets its own npmrc under a per-job directory instead, pointed at by
//     `npm_config_userconfig`; the developer's file is never written and never removed.
//
// Note the isolated path trades a little reach for that safety: `~/.npmrc` is read by npm, pnpm
// and yarn v1 alike, whereas `npm_config_userconfig` is honoured by npm and pnpm but NOT by yarn
// (v1 or Berry). A yarn-based checkout on the native path therefore sees only the developer's own
// registries, not the job's. Since the alternative is overwriting the file they actually use, the
// limitation stands — a yarn repo needing private-registry auth wants the container path.

/** Where the per-job npm auth lands in a container (the user npmrc, outside any checkout). */
export function npmrcPath(): string {
  return join(homedir(), '.npmrc')
}

/**
 * Per-job isolation for the rendered npmrc. Set `isolatedDir` when the harness process is
 * SHARED across concurrent jobs and its HOME is the developer's own — i.e. the local native
 * host-process transport, which is exactly the set of jobs carrying `ambientAuth`. Absent ⇒
 * the container default (`~/.npmrc`).
 */
export interface PackageRegistryScope {
  /** A per-job directory (removed with the job) to hold this job's npmrc. */
  isolatedDir?: string
}

/**
 * Render the job's registry entries as npmrc lines: each scope routed to its
 * registry, plus one `_authToken` credential line per distinct host.
 */
export function renderNpmrc(entries: readonly PackageRegistrySpec[]): string {
  const lines: string[] = []
  const hosts = new Map<string, string>()
  for (const entry of entries) {
    for (const scope of entry.scopes) {
      lines.push(`${scope}:registry=https://${entry.host}/`)
    }
    // Last entry wins per host — entries for the same host carry the same vendor
    // token in practice (the backend stores one token per entry).
    hosts.set(entry.host, entry.token)
  }
  for (const [host, token] of hosts) {
    lines.push(`//${host}/:_authToken=${token}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Write (or clear) the job's npmrc before the agent runs, and return the env the agent's child
 * process needs to find it (empty for the container default, which npm picks up from HOME).
 * Tokens are registered for output redaction so a token echoed in an npm error never reaches
 * logs or stored output.
 */
export async function configurePackageRegistries(
  entries: readonly PackageRegistrySpec[] | undefined,
  scope: PackageRegistryScope = {},
): Promise<Record<string, string>> {
  const hasEntries = Boolean(entries?.length)
  if (scope.isolatedDir) {
    // A job with no entries needs no file at all: emitting no override leaves the developer's
    // own `~/.npmrc` in effect (their private registries keep working) — and, crucially, leaves
    // it ALONE. Clearing a stale file is a container concern; here nothing stale can exist,
    // because the per-job dir is created and removed with the job.
    if (!hasEntries) return {}
    const path = join(scope.isolatedDir, '.npmrc')
    await writeIsolatedNpmrc(path, entries!)
    return { npm_config_userconfig: path }
  }
  const path = npmrcPath()
  if (!hasEntries) {
    await rm(path, { force: true })
    return {}
  }
  registerKnownSecrets(entries!.map((entry) => entry.token))
  await writeFile(path, renderNpmrc(entries!), { mode: 0o600 })
  // writeFile's mode only applies on create — tighten an existing file too.
  await chmod(path, 0o600)
  return {}
}

/**
 * Write the per-job npmrc, seeded from the developer's own `~/.npmrc` when they have one so
 * their unrelated settings (a corporate registry, a proxy) keep working for this run. The job's
 * lines are APPENDED, and npm resolves the last occurrence of a key, so the job's entries win on
 * any host they both configure. Copying their file into a 0600 temp adds no exposure: an ambient
 * run already has the developer's full file access by definition.
 *
 * The seeded credentials are registered for redaction alongside the job's own. The job's tokens
 * were always registered; the developer's were not, because before this path existed their file
 * was overwritten and no credential of theirs was in play during the run. Now that theirs is in
 * effect, an npm error echoing one must be scrubbed on exactly the same terms.
 */
async function writeIsolatedNpmrc(
  path: string,
  entries: readonly PackageRegistrySpec[],
): Promise<void> {
  registerKnownSecrets(entries.map((entry) => entry.token))
  // Best-effort: no personal npmrc (or an unreadable one) just means the job's entries stand alone.
  const inherited = await readFile(npmrcPath(), 'utf8').catch(() => '')
  registerKnownSecrets(npmrcCredentials(inherited))
  const prefix = inherited && !inherited.endsWith('\n') ? `${inherited}\n` : inherited
  await writeFile(path, `${prefix}${renderNpmrc(entries)}`, { mode: 0o600 })
  await chmod(path, 0o600)
}

/**
 * The credential VALUES in npmrc content: the three keys npm accepts a secret under, on any host
 * line. Used to register a seeded (developer-owned) file's tokens for redaction. An `${ENV_VAR}`
 * reference is not itself a secret — npm expands it at read time — so it is skipped rather than
 * registered as a literal to scrub.
 */
export function npmrcCredentials(content: string): string[] {
  const found: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:.*:)?_(?:authToken|auth|password)\s*=\s*(.+?)\s*$/.exec(line)
    const value = match?.[1]?.replace(/^["']|["']$/g, '')
    if (value && !/^\$\{.*\}$/.test(value)) found.push(value)
  }
  return found
}
