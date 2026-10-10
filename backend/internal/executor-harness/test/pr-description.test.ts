import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyPrDescription,
  PR_DESCRIPTION_FILE,
  PR_REPORT_MARKER_END,
  PR_REPORT_MARKER_START,
  preserveManagedSection,
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

  it('caps an over-long title line, marking the cut', async () => {
    write(`# ${'t'.repeat(500)}\n\nbody`)
    const title = (await readPrDescription(dir))?.title
    expect(title?.length).toBe(160)
    expect(title?.endsWith('…')).toBe(true)
  })

  it('cuts an over-long title at a word boundary when one is near', async () => {
    write(`# ${'word '.repeat(60)}tail\n\nbody`)
    const title = (await readPrDescription(dir))?.title
    expect(title?.endsWith('word…')).toBe(true)
  })

  // A briefing that uses `#` for its SECTION headings must not lose its first section to the
  // pull request's title — the dispatch-time `<block> (<pipeline>)` title is the better answer
  // than renaming the PR to "Problem".
  it('does not treat a section heading as the title when the file has several', async () => {
    write('# Problem\n\nRetries were unbounded.\n\n# Decisions\n\nCapped at three.')
    const parsed = await readPrDescription(dir)
    expect(parsed?.title).toBeUndefined()
    expect(parsed?.body).toContain('# Problem')
    expect(parsed?.body).toContain('# Decisions')
  })

  it('ignores a `#` comment inside fenced code when looking for the title', async () => {
    write('# Cap the retry loop\n\n```sh\n# rebuild the image\npnpm image:publish\n```')
    expect((await readPrDescription(dir))?.title).toBe('Cap the retry loop')
  })

  // The briefing lands verbatim on a host-parsed surface, and the platform auto-merges the PR
  // it describes: an unescaped `Fixes #412` would close issue 412 for real.
  it('defuses issue references, mentions and closing keywords', async () => {
    write('Fixes https://github.com/acme/w/issues/412 — ask @alice about !77 and #9.')
    const body = (await readPrDescription(dir))?.body
    expect(body).not.toMatch(/@alice/)
    expect(body).not.toMatch(/#9/)
    expect(body).not.toMatch(/!77/)
    expect(body).not.toMatch(/^Fixes\b/)
    // The reader still sees the original characters — only the parser is defeated.
    expect(body).toContain('&#64;alice')
  })

  it('leaves triggers inside a code span alone (the host does not link there either)', async () => {
    write('Match the literal `#123` marker.')
    expect((await readPrDescription(dir))?.body).toBe('Match the literal `#123` marker.')
  })

  // An unbalanced fence would swallow everything the engine appends afterwards — including the
  // verification report's fenced JSON block, which is its machine-readable contract.
  it('closes a code fence the briefing left open', async () => {
    write('Decided to inline the helper:\n\n```ts\nconst x = 1\n')
    expect((await readPrDescription(dir))?.body?.endsWith('```')).toBe(true)
  })

  it('closes a fence that TRUNCATION cut in half', async () => {
    write(`Intro\n\n\`\`\`ts\n${'const x = 1\n'.repeat(3_000)}\`\`\`\n`)
    const body = (await readPrDescription(dir))?.body
    expect(body).toContain('Truncated by the platform')
    expect(body?.endsWith('```')).toBe(true)
  })

  it('leaves the engine room in the PR body for its verification report', async () => {
    write('y'.repeat(60_000))
    const body = (await readPrDescription(dir))?.body
    // kernel's `MAX_SECTION_CHARS` is 50k and GitHub rejects a body over 65,536.
    expect(body!.length + 50_000).toBeLessThan(65_536)
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

// A resumed run's PR is already open, so refreshing it REWRITES a body the engine may already
// have published its verification report into. That region has to survive the rewrite.
describe('preserveManagedSection', () => {
  const report = `${PR_REPORT_MARKER_START}\n## Verification\n\nCI: green\n${PR_REPORT_MARKER_END}`

  it('carries an existing managed region across the rewrite', () => {
    const next = preserveManagedSection(`old briefing\n\n${report}\n`, 'fresh briefing')
    expect(next).toContain('fresh briefing')
    expect(next).toContain('## Verification')
    expect(next.indexOf('fresh briefing')).toBeLessThan(next.indexOf(PR_REPORT_MARKER_START))
    expect(next).not.toContain('old briefing')
  })

  it('returns the new body unchanged when there is no managed region', () => {
    expect(preserveManagedSection('old briefing', 'fresh briefing')).toBe('fresh briefing')
    expect(preserveManagedSection(undefined, 'fresh briefing')).toBe('fresh briefing')
  })

  it('treats a malformed region as none rather than guessing at its bounds', () => {
    const stray = `text ${PR_REPORT_MARKER_END} more ${PR_REPORT_MARKER_START}`
    expect(preserveManagedSection(stray, 'fresh')).toBe('fresh')
  })
})
