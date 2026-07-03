import { chmod, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PackageRegistrySpec } from './job.js'
import { registerKnownSecrets } from './redact.js'

// Private package-registry auth for the checkout's installs (npm private orgs,
// GitHub Packages). The job's allowlisted entries are rendered into the USER
// `~/.npmrc` — read by npm, pnpm and yarn v1 alike, and inherited by every child
// process (the agent's own shell installs and the frontend-infra stand-up's) — so
// the token never rides argv or the checkout. Written per job; a job with NO
// entries removes any stale file, because warm-pool containers are reused across
// jobs and must not leak a prior workspace's token.

/** Where the per-job npm auth lands (the user npmrc, outside any checkout). */
export function npmrcPath(): string {
  return join(homedir(), '.npmrc')
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
 * Write (or clear) the per-job `~/.npmrc` before the agent runs. Tokens are
 * registered for output redaction so a token echoed in an npm error never reaches
 * logs or stored output.
 */
export async function configurePackageRegistries(
  entries: readonly PackageRegistrySpec[] | undefined,
): Promise<void> {
  const path = npmrcPath()
  if (!entries || entries.length === 0) {
    await rm(path, { force: true })
    return
  }
  registerKnownSecrets(entries.map((entry) => entry.token))
  await writeFile(path, renderNpmrc(entries), { mode: 0o600 })
  // writeFile's mode only applies on create — tighten an existing file too.
  await chmod(path, 0o600)
}
