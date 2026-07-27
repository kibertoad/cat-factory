import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyPrDescription,
  PR_DESCRIPTION_FILE,
  readPrDescription,
} from '../src/pr-description.js'

// The agent-authored PR description side channel: `readPrDescription` reads + parses + REMOVES
// the sentinel the agent wrote at the checkout root. It must be lenient (never throw), scrub
// secrets, keep the engine's managed-report markers out, and cap size with a VISIBLE note —
// a bad briefing must never fail an otherwise-good run, only fall back to the dispatch text.

describe('readPrDescription', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pr-desc-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (content: string, at: string = dir) =>
    writeFileSync(join(at, PR_DESCRIPTION_FILE), content, 'utf8')

  it('returns undefined when no sentinel was written', async () => {
    expect(await readPrDescription(dir)).toBeUndefined()
  })

  it('reads a body-only briefing and removes the sentinel', async () => {
    write('The problem: retries were unbounded.\n\nDecided to cap at 3; a queue was rejected.\n')
    expect(await readPrDescription(dir)).toEqual({
      body: 'The problem: retries were unbounded.\n\nDecided to cap at 3; a queue was rejected.',
    })
    // Removed so it never lingers in the checkout.
    expect(existsSync(join(dir, PR_DESCRIPTION_FILE))).toBe(false)
  })

  it('lifts a leading `# ` heading into the title', async () => {
    write('# Cap retry loop at three attempts\n\nWhy: unbounded retries hammered the provider.')
    expect(await readPrDescription(dir)).toEqual({
      title: 'Cap retry loop at three attempts',
      body: 'Why: unbounded retries hammered the provider.',
    })
  })

  it('keeps a title-only file as title with no body', async () => {
    write('# Cap retry loop at three attempts\n\n   \n')
    expect(await readPrDescription(dir)).toEqual({ title: 'Cap retry loop at three attempts' })
  })

  it('does not treat a deeper heading or mid-file heading as the title', async () => {
    write('## Context\n\nBody text.')
    expect(await readPrDescription(dir)).toEqual({ body: '## Context\n\nBody text.' })
  })

  it('returns undefined (and removes the file) for blank content', async () => {
    write('   \n\n  ')
    expect(await readPrDescription(dir)).toBeUndefined()
    expect(existsSync(join(dir, PR_DESCRIPTION_FILE))).toBe(false)
  })

  it('scrubs credential shapes from the briefing', async () => {
    write('Cloned via https://x:ghp_abc123@github.com and TOKEN=hunter2 was set.')
    const parsed = await readPrDescription(dir)
    expect(parsed?.body).not.toContain('ghp_abc123')
    expect(parsed?.body).not.toContain('hunter2')
  })

  it("strips the engine's managed verification-report markers", async () => {
    write(
      'Before <!-- cat-factory:verification-report:start --> middle ' +
        '<!--cat-factory:verification-report:end--> after',
    )
    expect((await readPrDescription(dir))?.body).toBe('Before  middle  after')
  })

  it('truncates an over-budget body with a visible note', async () => {
    write(`# T\n\n${'x'.repeat(30_000)}`)
    const parsed = await readPrDescription(dir)
    expect(parsed?.body?.length).toBeLessThan(30_000)
    expect(parsed?.body).toContain('Truncated by the platform')
  })

  it('caps an over-long title line', async () => {
    write(`# ${'t'.repeat(500)}\n\nbody`)
    expect((await readPrDescription(dir))?.title?.length).toBe(160)
  })

  it('keeps two concurrent checkouts fully separate (per-job state)', async () => {
    const other = mkdtempSync(join(tmpdir(), 'pr-desc-b-'))
    try {
      write('# Job A\n\nbriefing A')
      write('# Job B\n\nbriefing B', other)
      const [a, b] = await Promise.all([readPrDescription(dir), readPrDescription(other)])
      expect(a).toEqual({ title: 'Job A', body: 'briefing A' })
      expect(b).toEqual({ title: 'Job B', body: 'briefing B' })
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('applyPrDescription', () => {
  const fallback = { title: 'Block (Pipeline)', body: 'dispatch-time text' }

  it('returns the fallback untouched when the agent wrote nothing', () => {
    expect(applyPrDescription(fallback, undefined)).toEqual(fallback)
  })

  it('lets agent title and body each win field-wise', () => {
    expect(applyPrDescription(fallback, { title: 'T', body: 'B' })).toEqual({
      title: 'T',
      body: 'B',
    })
    expect(applyPrDescription(fallback, { body: 'B' })).toEqual({
      title: 'Block (Pipeline)',
      body: 'B',
    })
    expect(applyPrDescription(fallback, { title: 'T' })).toEqual({
      title: 'T',
      body: 'dispatch-time text',
    })
  })
})
