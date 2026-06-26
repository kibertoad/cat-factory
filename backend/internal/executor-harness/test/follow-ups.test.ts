import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FollowUpTailer, type FollowUpLine } from '../src/follow-ups.js'

// The Coder appends JSON lines to a sentinel file; the tailer yields only the NEW complete
// lines per poll (drain-on-read), holding back a partially-written trailing line. A
// malformed or missing line never disturbs the run.
describe('FollowUpTailer', () => {
  let dir: string
  let file: string
  let received: FollowUpLine[]
  let tailer: FollowUpTailer

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'followups-'))
    file = join(dir, '.cat-follow-ups.jsonl')
    received = []
    tailer = new FollowUpTailer(file, (items) => received.push(...items))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('yields nothing when the file does not exist yet', async () => {
    await tailer.poll()
    expect(received).toEqual([])
  })

  it('surfaces complete lines and coerces kind/detail', async () => {
    await writeFile(
      file,
      `${JSON.stringify({ kind: 'follow_up', title: 'Dedupe util', detail: 'two copies' })}\n` +
        `${JSON.stringify({ title: 'No kind defaults to follow_up' })}\n` +
        `${JSON.stringify({ kind: 'question', title: 'Which db?', detail: 'pg or sqlite' })}\n`,
      'utf8',
    )
    await tailer.poll()
    expect(received).toEqual([
      { kind: 'follow_up', title: 'Dedupe util', detail: 'two copies' },
      { kind: 'follow_up', title: 'No kind defaults to follow_up', detail: '' },
      { kind: 'question', title: 'Which db?', detail: 'pg or sqlite' },
    ])
  })

  it('drains only new lines across polls and holds a partial trailing line', async () => {
    await writeFile(file, `${JSON.stringify({ title: 'first' })}\n`, 'utf8')
    await tailer.poll()
    expect(received.map((i) => i.title)).toEqual(['first'])

    // A second poll with no new content yields nothing (drain-on-read).
    await tailer.poll()
    expect(received).toHaveLength(1)

    // A partially-written line (no trailing newline) is held back until it completes.
    await appendFile(file, `${JSON.stringify({ title: 'second' })}`, 'utf8')
    await tailer.poll()
    expect(received).toHaveLength(1)
    await appendFile(file, '\n', 'utf8')
    await tailer.poll()
    expect(received.map((i) => i.title)).toEqual(['first', 'second'])
  })

  it('skips malformed and titleless lines without throwing', async () => {
    await writeFile(
      file,
      `not json at all\n${JSON.stringify({ detail: 'no title' })}\n${JSON.stringify({ title: 'ok' })}\n`,
      'utf8',
    )
    await tailer.poll()
    expect(received.map((i) => i.title)).toEqual(['ok'])
  })
})
