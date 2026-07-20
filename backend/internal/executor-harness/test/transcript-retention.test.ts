import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RETENTION_MARKER, retainSessionTranscripts } from '../src/transcript-retention.js'

// Drives the REAL `retainSessionTranscripts` against a temp config home + an isolated
// retention root (via `HARNESS_TRANSCRIPT_ROOT`), so the move-out-then-prune behaviour and
// the credential-safety property are asserted end-to-end on the real filesystem.

let home: string
let root: string
let priorRoot: string | undefined
let priorTtl: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cf-claude-'))
  root = mkdtempSync(join(tmpdir(), 'cf-retain-root-'))
  priorRoot = process.env.HARNESS_TRANSCRIPT_ROOT
  priorTtl = process.env.HARNESS_TRANSCRIPT_TTL_MS
  process.env.HARNESS_TRANSCRIPT_ROOT = root
  delete process.env.HARNESS_TRANSCRIPT_TTL_MS
})

afterEach(() => {
  if (priorRoot === undefined) delete process.env.HARNESS_TRANSCRIPT_ROOT
  else process.env.HARNESS_TRANSCRIPT_ROOT = priorRoot
  if (priorTtl === undefined) delete process.env.HARNESS_TRANSCRIPT_TTL_MS
  else process.env.HARNESS_TRANSCRIPT_TTL_MS = priorTtl
  rmSync(home, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

/** Seed a config home with a credential at the root and a transcript subtree. */
function seedHome(): void {
  writeFileSync(join(home, '.claude.json'), '{"credential":"secret"}')
  mkdirSync(join(home, 'projects', 'proj-a'), { recursive: true })
  writeFileSync(join(home, 'projects', 'proj-a', 'session.jsonl'), '{"turn":1}\n')
}

describe('retainSessionTranscripts', () => {
  it('moves the transcript subtree out to the retention root, preserving contents', async () => {
    seedHome()

    const dest = await retainSessionTranscripts(home, ['projects'], { label: 'claude-code' })

    // The subdir is GONE from the home (so the caller's later `rm(home)` can't take it) ...
    expect(existsSync(join(home, 'projects'))).toBe(false)
    // ... and its contents survive under the returned retention dir.
    expect(dest).toBeDefined()
    const retained = join(dest!, 'projects', 'proj-a', 'session.jsonl')
    expect(readFileSync(retained, 'utf8')).toBe('{"turn":1}\n')
  })

  it('never retains the credential at the home root', async () => {
    seedHome()

    const dest = await retainSessionTranscripts(home, ['projects'], {})

    // The retained tree carries only `projects/`, never the root credential file.
    expect(existsSync(join(dest!, '.claude.json'))).toBe(false)
    // And the credential is still where the caller left it (its own `rm(home)` removes it).
    expect(existsSync(join(home, '.claude.json'))).toBe(true)
  })

  it('is a no-op (no throw, no dest) when the subdir is absent', async () => {
    writeFileSync(join(home, '.claude.json'), '{"credential":"secret"}')

    const dest = await retainSessionTranscripts(home, ['projects'], {})

    expect(dest).toBeUndefined()
  })

  it('prunes retained transcripts older than the TTL and keeps fresh ones', async () => {
    // A stale retained dir from a prior run, back-dated well beyond the 3-day default TTL.
    // Marker written BEFORE the utimes back-date so the dir's mtime stays in the past.
    const stale = join(root, '2000-01-01T00-00-00-000Z-cf-claude-old')
    mkdirSync(join(stale, 'projects'), { recursive: true })
    writeFileSync(join(stale, RETENTION_MARKER), '')
    const longAgo = new Date('2000-01-01T00:00:00Z')
    utimesSync(stale, longAgo, longAgo)

    seedHome()
    const dest = await retainSessionTranscripts(home, ['projects'], {})

    // The expired backlog is swept ...
    expect(existsSync(stale)).toBe(false)
    // ... while this run's freshly-retained transcripts remain.
    expect(existsSync(dest!)).toBe(true)
  })

  it('honours a custom TTL via HARNESS_TRANSCRIPT_TTL_MS', async () => {
    process.env.HARNESS_TRANSCRIPT_TTL_MS = '1000' // 1s window

    // A retained dir aged ~1 hour — fresh under the 3-day default, expired under the 1s TTL.
    const aged = join(root, 'aged-cf-claude-x')
    mkdirSync(aged, { recursive: true })
    writeFileSync(join(aged, RETENTION_MARKER), '')
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(aged, anHourAgo, anHourAgo)

    seedHome()
    await retainSessionTranscripts(home, ['projects'], {})

    expect(existsSync(aged)).toBe(false)
    // Sanity: the retention root still exists and holds this run's dir.
    expect(readdirSync(root).length).toBeGreaterThan(0)
  })

  it('never prunes foreign dirs lacking the retention marker (shared-root safety)', async () => {
    // An unrelated, ancient directory a co-tenant left under a SHARED retention root — no
    // marker, so the sweep must leave it strictly alone even though it's well past the TTL.
    const foreign = join(root, 'someone-elses-important-data')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'keep.txt'), 'do not delete')
    const longAgo = new Date('2000-01-01T00:00:00Z')
    utimesSync(foreign, longAgo, longAgo)

    seedHome()
    await retainSessionTranscripts(home, ['projects'], {})

    // The foreign dir and its contents survive the prune untouched.
    expect(existsSync(foreign)).toBe(true)
    expect(readFileSync(join(foreign, 'keep.txt'), 'utf8')).toBe('do not delete')
  })
})
