import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCodexHome, disposeCodexHome } from '../src/codex-home.js'
import { GENERATED_BINARY_DIR } from '../src/codex-images.js'

// The per-run `CODEX_HOME` lifecycle, driven directly rather than through a fake CLI on PATH — the
// runner suite's codex cases are unix-only shell scripts, which left the credential/config/teardown
// rules unexercised on a developer's machine. Everything here is filesystem behaviour, so it runs
// everywhere.

describe('createCodexHome', () => {
  let cwd: string
  const homes: string[] = []

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'cf-cwd-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
  })

  const create = async (opts: Parameters<typeof createCodexHome>[0]) => {
    const home = await createCodexHome(opts)
    if (home) homes.push(home)
    return home
  }

  it('refuses a leased run with no credential', async () => {
    await expect(create({ cwd })).rejects.toThrow(/subscription token/)
  })

  it('writes NOTHING for an ambient run', async () => {
    // The developer's own `~/.codex` is never reconfigured: that is the HOME-global mutation this
    // harness does not make, and it is why MCP servers and image staging are both unavailable here.
    expect(await create({ cwd, ambientAuth: true })).toBeUndefined()
  })

  it('keeps the credential OUT of the checkout', async () => {
    // Several handlers finish with `git add -A` + push, so an auth.json under cwd would be
    // published to the PR branch.
    const home = await create({ cwd, subscriptionToken: '{"tokens":{}}' })
    expect(home).toBeDefined()
    expect(home!.startsWith(cwd)).toBe(false)
    await expect(readFile(join(home!, 'auth.json'), 'utf8')).resolves.toBe('{"tokens":{}}')
    expect(await readdir(cwd)).not.toContain('auth.json')
  })

  it('writes the credential read-only to its owner', async () => {
    const home = await create({ cwd, subscriptionToken: 'tok' })
    const mode = (await stat(join(home!, 'auth.json'))).mode & 0o777
    // Skipped on Windows, which does not model POSIX permission bits.
    if (process.platform !== 'win32') expect(mode).toBe(0o600)
  })

  it('does NOT enable the image tool by default', async () => {
    // It bills the leased plan at several times an ordinary turn, so every non-generating run
    // would pay for a capability nobody asked for.
    const home = await create({ cwd, subscriptionToken: 'tok' })
    const config = await readFile(join(home!, 'config.toml'), 'utf8')
    expect(config).toContain('cli_auth_credentials_store = "file"')
    expect(config).not.toContain('image_generation')
  })

  it('enables the image tool and stages its output when the dispatch asked for it', async () => {
    const home = await create({ cwd, subscriptionToken: 'tok', generateImages: true })
    const config = await readFile(join(home!, 'config.toml'), 'utf8')
    expect(config).toContain('[features]')
    expect(config).toContain('image_generation = true')
    // And the redirect is in place before the CLI could ever run.
    await expect(readdir(join(cwd, GENERATED_BINARY_DIR))).resolves.toEqual([])
  })
})

describe('disposeCodexHome', () => {
  it('deletes the credential and never follows the redirect into the checkout', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cf-cwd-'))
    try {
      const home = await createCodexHome({ cwd, subscriptionToken: 'tok', generateImages: true })
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(home!, 'generated_images', 'art.png'), 'PNG', 'utf8')
      await disposeCodexHome(home!, { cwd, subscriptionToken: 'tok', generateImages: true })
      // The credential is gone...
      await expect(stat(home!)).rejects.toThrow()
      // ...and the run's own output survived, which is what unlinking (not following) the
      // redirect before the recursive delete buys.
      await expect(readFile(join(cwd, GENERATED_BINARY_DIR, 'art.png'), 'utf8')).resolves.toBe(
        'PNG',
      )
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('deletes the home for a non-generating run too', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cf-cwd-'))
    try {
      const home = await createCodexHome({ cwd, subscriptionToken: 'tok' })
      await disposeCodexHome(home!, { cwd, subscriptionToken: 'tok' })
      await expect(stat(home!)).rejects.toThrow()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
