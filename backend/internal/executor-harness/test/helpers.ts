import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, vi } from 'vitest'

// Shared fixtures for the harness suite. Anything that redirects real, process-global state
// (the home directory, and the dot-files the harness writes into it) belongs here rather than
// re-implemented per spec — the traps below were each rediscovered the hard way.

/**
 * Point the process's HOME DIRECTORY at a fresh temp dir for the current test, and clean it up
 * afterwards. Returns the directory, so a test can read back whatever the code under test wrote
 * into it.
 *
 * Stubs `USERPROFILE` as well as `HOME` because that — not `HOME` — is what `os.homedir()`
 * reads on Windows, and `homedir()` is what the code under test uses to place `~/.npmrc`,
 * `~/.pi/agent/AGENTS.md`, `~/.config/rpiv-web-tools/config.json` and friends. Stubbing only
 * `HOME` leaves the REAL home directory in effect there, which fails in two ways: a test that
 * reads its file back from the temp dir errors with ENOENT, and — far worse — one that reads
 * back via the production path helper silently passes while WRITING INTO THE DEVELOPER'S OWN
 * HOME DIRECTORY, overwriting the `~/.npmrc` they actually use.
 *
 * The env stubs are `vi.stubEnv`, so they also unwind on `vi.unstubAllEnvs()`.
 */
export async function stubTempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'harness-home-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  onTestFinished(async () => {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })
  return home
}

/**
 * Whether the filesystem under test honours POSIX permission bits. Windows does not: Node's
 * `chmod` there only toggles the read-only attribute, so a file written with mode `0o600` stats
 * back as `0o666`. Guard permission assertions with this rather than weakening them — the
 * tightened mode is a real security property on the platform the harness image runs on (Linux),
 * and asserting it loosely everywhere would stop catching a regression there.
 */
export const FS_HAS_POSIX_MODES = process.platform !== 'win32'
