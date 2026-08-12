import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GENERATED_BINARY_DIR,
  stageCodexImages,
  sweepCodexImages,
  unstageCodexImages,
} from '../src/codex-images.js'

// Codex writes its `image_gen` output under `$CODEX_HOME` and tells the model no path for it, while
// `$CODEX_HOME` is also where the run's decrypted subscription credential lives. These pin the two
// properties that make the redirect safe: the agent's staging directory is inside the checkout (so
// it never has to read the credential's directory), and tearing the redirect down never follows the
// link into the run's own output.

// The redirect is a directory SYMLINK on Linux (the container) and a JUNCTION on Windows, which
// needs no privilege — so these run everywhere rather than being gated to the container's platform.
// Gating them would leave the feature's central mechanism unexercised on a developer's machine.

describe('codex image staging', () => {
  let home: string
  let cwd: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cf-codex-home-'))
    cwd = await mkdtemp(join(tmpdir(), 'cf-codex-cwd-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  })

  it('stages into the checkout, never into the credential directory', () => {
    // The path the brief names, and the property the whole redirect exists for.
    expect(GENERATED_BINARY_DIR).toBe('.cat-context/binary-output/generated')
    expect(GENERATED_BINARY_DIR.startsWith('.cat-context/')).toBe(true)
  })

  it('creates the staging directory the agent is told to read', async () => {
    await stageCodexImages(home, cwd)
    await expect(readdir(join(cwd, GENERATED_BINARY_DIR))).resolves.toEqual([])
  })

  it('excludes the staged output from git, so an un-uploaded image cannot be committed', async () => {
    // A coding run ends with `git add -A`. Without this a generated PNG lands in the customer's PR.
    await mkdir(join(cwd, '.git', 'info'), { recursive: true })
    await writeFile(join(cwd, '.git', 'info', 'exclude'), '', 'utf8')
    await stageCodexImages(home, cwd)
    const exclude = await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('.cat-context/')
  })

  it('redirects the CLI output directory into the checkout', async () => {
    expect(await stageCodexImages(home, cwd)).toBe(true)
    // Writing where codex writes must land where the agent reads, with no copy step in between:
    // that is what removes the race between generating a file and uploading it.
    await writeFile(join(home, 'generated_images', 'sprite.png'), 'PNG', 'utf8')
    await expect(readFile(join(cwd, GENERATED_BINARY_DIR, 'sprite.png'), 'utf8')).resolves.toBe(
      'PNG',
    )
  })

  it('leaves an EXISTING output directory alone rather than replacing it', async () => {
    // On the ambient path that directory is the developer's own history, and replacing it with a
    // link into a throwaway checkout would destroy it.
    await mkdir(join(home, 'generated_images'), { recursive: true })
    await writeFile(join(home, 'generated_images', 'mine.png'), 'MINE', 'utf8')
    expect(await stageCodexImages(home, cwd)).toBe(false)
    await expect(readFile(join(home, 'generated_images', 'mine.png'), 'utf8')).resolves.toBe('MINE')
  })

  it('reports a failed redirect rather than throwing, so the run still happens', async () => {
    // The agent may have plenty of non-generating work; the sweep is what stops files being lost.
    await mkdir(join(home, 'generated_images'), { recursive: true })
    expect(await stageCodexImages(home, cwd)).toBe(false)
  })
})

describe('sweepCodexImages', () => {
  let home: string
  let cwd: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cf-codex-home-'))
    cwd = await mkdtemp(join(tmpdir(), 'cf-codex-cwd-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  })

  it('answers empty when the run generated nothing', async () => {
    expect(await sweepCodexImages(home, cwd)).toEqual([])
  })

  it('moves files a failed redirect left behind, and NAMES them', async () => {
    // Named rather than quietly rescued: anything here arrived too late for the agent to upload,
    // which is a different fact from a run that generated none.
    await mkdir(join(home, 'generated_images'), { recursive: true })
    await writeFile(join(home, 'generated_images', 'late.png'), 'LATE', 'utf8')
    expect(await sweepCodexImages(home, cwd)).toEqual(['late.png'])
    await expect(readFile(join(cwd, GENERATED_BINARY_DIR, 'late.png'), 'utf8')).resolves.toBe(
      'LATE',
    )
  })

  it('finds nothing to move when the redirect worked', async () => {
    await stageCodexImages(home, cwd)
    await writeFile(join(home, 'generated_images', 'sprite.png'), 'PNG', 'utf8')
    // Reading through the link lists the staging directory, whose files are already in place.
    expect(await sweepCodexImages(home, cwd)).toEqual([])
    await expect(readFile(join(cwd, GENERATED_BINARY_DIR, 'sprite.png'), 'utf8')).resolves.toBe(
      'PNG',
    )
  })
})

describe('unstageCodexImages', () => {
  it('unlinks the redirect and leaves the run’s output intact', async () => {
    // The teardown that follows deletes CODEX_HOME recursively. If the link were still there and
    // followed, it would take the checkout's generated artifacts with it.
    const home = await mkdtemp(join(tmpdir(), 'cf-codex-home-'))
    const cwd = await mkdtemp(join(tmpdir(), 'cf-codex-cwd-'))
    try {
      await stageCodexImages(home, cwd)
      await writeFile(join(home, 'generated_images', 'keep.png'), 'KEEP', 'utf8')
      await unstageCodexImages(home)
      await rm(home, { recursive: true, force: true })
      await expect(readFile(join(cwd, GENERATED_BINARY_DIR, 'keep.png'), 'utf8')).resolves.toBe(
        'KEEP',
      )
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
