import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EFFORT_REPORT_FILE, readEffortReport } from '../src/effort.js'

// The agent effort self-assessment side channel: `readEffortReport` reads + coerces + REMOVES
// the sentinel the agent wrote to its cwd. It must be lenient (never throw) and drop anything
// that carries nothing meaningful, so a malformed self-report can't fail an otherwise-good run.

describe('readEffortReport', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'effort-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (content: string) => writeFileSync(join(dir, EFFORT_REPORT_FILE), content, 'utf8')

  it('returns undefined when no sentinel was written', async () => {
    expect(await readEffortReport(dir)).toBeUndefined()
  })

  it('parses a full report and removes the sentinel', async () => {
    write(
      JSON.stringify({
        difficulty: 7,
        summary: '  Non-trivial refactor.  ',
        reducedEffectiveness: 'Flaky tests',
        obstacles: ['missing docs', '  ', 'unclear spec'],
      }),
    )
    const report = await readEffortReport(dir)
    expect(report).toEqual({
      difficulty: 7,
      summary: 'Non-trivial refactor.',
      reducedEffectiveness: 'Flaky tests',
      obstacles: ['missing docs', 'unclear spec'],
    })
    // Removed so it never lands in a commit.
    expect(existsSync(join(dir, EFFORT_REPORT_FILE))).toBe(false)
  })

  it('clamps and rounds difficulty into 1..10', async () => {
    write(JSON.stringify({ difficulty: 42, summary: 'x' }))
    expect((await readEffortReport(dir))?.difficulty).toBe(10)
    write(JSON.stringify({ difficulty: -3, summary: 'x' }))
    expect((await readEffortReport(dir))?.difficulty).toBe(1)
    write(JSON.stringify({ difficulty: 6.6, summary: 'x' }))
    expect((await readEffortReport(dir))?.difficulty).toBe(7)
  })

  it('coerces a numeric-string difficulty', async () => {
    write(JSON.stringify({ difficulty: '8', summary: 'x' }))
    expect((await readEffortReport(dir))?.difficulty).toBe(8)
  })

  it('defaults difficulty to 5 when it is present-but-unparseable (with other content)', async () => {
    write(JSON.stringify({ difficulty: 'hard', summary: 'x' }))
    expect((await readEffortReport(dir))?.difficulty).toBe(5)
  })

  it('drops a content-free report (only a defaulted difficulty, no prose/obstacles)', async () => {
    write(JSON.stringify({}))
    expect(await readEffortReport(dir)).toBeUndefined()
    write(JSON.stringify({ obstacles: ['   '] }))
    expect(await readEffortReport(dir)).toBeUndefined()
  })

  it('keeps a report that has only a difficulty', async () => {
    write(JSON.stringify({ difficulty: 3 }))
    expect(await readEffortReport(dir)).toEqual({ difficulty: 3 })
  })

  it('returns undefined (and removes the file) for non-JSON or non-object content', async () => {
    write('not json {{')
    expect(await readEffortReport(dir)).toBeUndefined()
    expect(existsSync(join(dir, EFFORT_REPORT_FILE))).toBe(false)
    write('"a bare string"')
    expect(await readEffortReport(dir)).toBeUndefined()
  })
})
