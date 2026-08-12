import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexImageGapNote, createCodexHome, disposeCodexHome } from '../src/codex-home.js'
import { GENERATED_BINARY_DIR } from '../src/codex-images.js'
import type { Logger } from '../src/logger.js'

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
    const setup = await createCodexHome(opts)
    if (setup.home) homes.push(setup.home)
    return setup
  }

  it('refuses a leased run with no credential', async () => {
    await expect(create({ cwd })).rejects.toThrow(/subscription token/)
  })

  it('writes NOTHING for an ambient run', async () => {
    // The developer's own `~/.codex` is never reconfigured: that is the HOME-global mutation this
    // harness does not make, and it is why MCP servers and image staging are both unavailable here.
    expect(await create({ cwd, ambientAuth: true })).toEqual({})
  })

  it('STATES the dropped image capability on an ambient run rather than going quiet', async () => {
    // The backend already composed a brief naming the staging directory and told the agent to
    // collect from it. Dropping the capability silently leaves the agent hunting for files nothing
    // wrote and reporting a vendor problem for a configuration one.
    const setup = await create({ cwd, ambientAuth: true, generateImages: true })
    expect(setup.home).toBeUndefined()
    expect(setup.images).toEqual({ state: 'unavailable', reason: 'ambient-home' })
  })

  it('keeps the credential OUT of the checkout', async () => {
    // Several handlers finish with `git add -A` + push, so an auth.json under cwd would be
    // published to the PR branch.
    const { home } = await create({ cwd, subscriptionToken: '{"tokens":{}}' })
    expect(home).toBeDefined()
    expect(home!.startsWith(cwd)).toBe(false)
    await expect(readFile(join(home!, 'auth.json'), 'utf8')).resolves.toBe('{"tokens":{}}')
    expect(await readdir(cwd)).not.toContain('auth.json')
  })

  it('writes the credential read-only to its owner', async () => {
    const { home } = await create({ cwd, subscriptionToken: 'tok' })
    const mode = (await stat(join(home!, 'auth.json'))).mode & 0o777
    // Skipped on Windows, which does not model POSIX permission bits.
    if (process.platform !== 'win32') expect(mode).toBe(0o600)
  })

  it('does NOT enable the image tool by default', async () => {
    // It bills the leased plan at several times an ordinary turn, so every non-generating run
    // would pay for a capability nobody asked for.
    const { home, images } = await create({ cwd, subscriptionToken: 'tok' })
    const config = await readFile(join(home!, 'config.toml'), 'utf8')
    expect(config).toContain('cli_auth_credentials_store = "file"')
    expect(config).not.toContain('image_generation')
    // Nothing to say about a capability the job never asked for.
    expect(images).toBeUndefined()
  })

  it('enables the image tool and stages its output when the dispatch asked for it', async () => {
    const { home, images } = await create({ cwd, subscriptionToken: 'tok', generateImages: true })
    const config = await readFile(join(home!, 'config.toml'), 'utf8')
    expect(config).toContain('[features]')
    expect(config).toContain('image_generation = true')
    // And the redirect is in place before the CLI could ever run.
    await expect(readdir(join(cwd, GENERATED_BINARY_DIR))).resolves.toEqual([])
    expect(images).toEqual({ state: 'staged' })
  })
})

describe('codexImageGapNote', () => {
  it('says nothing about a run that generated fine, or one that never asked', () => {
    expect(codexImageGapNote(undefined)).toBeUndefined()
    expect(codexImageGapNote({ state: 'staged' })).toBeUndefined()
  })

  it('names the staging directory and the instruction the brief already gave', () => {
    // The pairing that makes the brief's "if the tool is unavailable, say so" reachable: only this
    // half knows the tool is not there.
    for (const reason of ['ambient-home', 'redirect-refused'] as const) {
      const note = codexImageGapNote({ state: 'unavailable', reason })
      expect(note).toContain(GENERATED_BINARY_DIR)
      expect(note).toMatch(/could NOT be/)
    }
  })

  it('distinguishes the two causes, which need different fixes', () => {
    // One is a deployment mode (ambient CLI login), the other a filesystem that refused the
    // redirect. A single message would send the reader to the wrong half.
    const ambient = codexImageGapNote({ state: 'unavailable', reason: 'ambient-home' })
    const refused = codexImageGapNote({ state: 'unavailable', reason: 'redirect-refused' })
    expect(ambient).not.toEqual(refused)
  })
})

describe('disposeCodexHome', () => {
  it('deletes the credential and never follows the redirect into the checkout', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cf-cwd-'))
    try {
      const { home } = await createCodexHome({
        cwd,
        subscriptionToken: 'tok',
        generateImages: true,
      })
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
      const { home } = await createCodexHome({ cwd, subscriptionToken: 'tok' })
      await disposeCodexHome(home!, { cwd, subscriptionToken: 'tok' })
      await expect(stat(home!)).rejects.toThrow()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('attributes a rescued file to the redirect that never existed, not to a late arrival', async () => {
    // Both cases rescue files; only one of them is the agent finishing before the CLI wrote. Told
    // apart by the setup outcome rather than guessed, because "late" points the next reader at the
    // model and "never redirected" points them at the filesystem.
    const cwd = await mkdtemp(join(tmpdir(), 'cf-cwd-'))
    const warnings: string[] = []
    const log: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message) => void warnings.push(message),
      error: () => {},
      child: () => log,
    }
    try {
      const { home } = await createCodexHome({ cwd, subscriptionToken: 'tok' })
      const { mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(join(home!, 'generated_images'), { recursive: true })
      await writeFile(join(home!, 'generated_images', 'orphan.png'), 'PNG', 'utf8')
      await disposeCodexHome(
        home!,
        { cwd, subscriptionToken: 'tok', generateImages: true, log },
        { state: 'unavailable', reason: 'redirect-refused' },
      )
      expect(warnings.some((line) => line.includes('never in place'))).toBe(true)
      await expect(readFile(join(cwd, GENERATED_BINARY_DIR, 'orphan.png'), 'utf8')).resolves.toBe(
        'PNG',
      )
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
