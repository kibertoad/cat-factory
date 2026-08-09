import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Journal, readJournal } from '../src/journal.ts'

// The journal is what makes a pass watchable from another window and readable after the terminal
// is gone. Two properties carry that, and both are pinned here: an event survives the process
// that wrote it, and a write that fails costs the observation rather than the hour-long run.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'cf-journal-'))
}

describe('Journal', () => {
  it('appends events a later reader sees, in order', () => {
    const dir = scratch()
    const journal = new Journal(dir, 'run-1', '01-bootstrap')
    journal.record('milestone', 'filed the task')
    journal.record('observation', 'step 3 coder working')

    const events = readJournal(join(dir, 'run-1.journal.jsonl'))
    expect(events.map((event) => event.message)).toEqual(['filed the task', 'step 3 coder working'])
    expect(events[0]?.phase).toBe('01-bootstrap')
  })

  it('binds later events to the phase most recently entered', () => {
    const dir = scratch()
    const journal = new Journal(dir, 'run-1', 'suite')
    journal.record('observation', 'before any spec')
    journal.enterPhase('02-feature')
    journal.record('observation', 'still working')

    const events = readJournal(journal.path)
    expect(events.map((event) => event.phase)).toEqual(['suite', '02-feature', '02-feature'])
  })

  it('survives an unwritable state directory rather than killing the pass', () => {
    // The whole reason for the latch: a journal is a reporting side channel, and a full disk must
    // never cost the run that produced the observation.
    const journal = new Journal(join(scratch(), 'file-not-a-dir', '\0bad'), 'run-1')
    expect(() => journal.record('milestone', 'anything')).not.toThrow()
  })
})

describe('readJournal', () => {
  it('treats an absent journal as no events', () => {
    expect(readJournal(join(scratch(), 'nope.jsonl'))).toEqual([])
  })

  it('skips a truncated tail, which is the normal state of a file being appended to', () => {
    const path = join(scratch(), 'partial.jsonl')
    writeFileSync(
      path,
      `${JSON.stringify({ at: 1, phase: 'p', kind: 'milestone', message: 'whole' })}\n{"at":2,"pha`,
      'utf8',
    )
    // A pass read while it is running routinely has half a line at the end. Refusing the file
    // over it would make the status command unusable at exactly the moment it is wanted.
    expect(readJournal(path).map((event) => event.message)).toEqual(['whole'])
  })

  it('skips a line missing a required field rather than surfacing a partial event', () => {
    const path = join(scratch(), 'wrong.jsonl')
    writeFileSync(path, `${JSON.stringify({ at: 1, phase: 'p', kind: 'milestone' })}\n`, 'utf8')
    expect(readJournal(path)).toEqual([])
  })
})
