import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findMostRecentPass,
  latestPointerPath,
  listPasses,
  passPaths,
  readLatestRunId,
  resolveStateDir,
  writeLatestPointer,
} from '../src/passFiles.ts'

// What is pinned here is which pass a directory ANSWERS WITH, because the two questions asked of it
// look alike and have different answers: "what ran last" (this file) and "what is worth resuming"
// (the `latest` pointer). Conflating them is what left an operator's refused attempt unreportable
// while its journal sat in the directory being read.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'cf-passfiles-'))
}

/** Write one pass's files, stamped so "which ran last" is a fact of the test rather than of timing. */
function pass(dir: string, runId: string, at: number, files: readonly ('ledger' | 'journal')[]) {
  const paths = passPaths(dir, runId)
  if (files.includes('ledger')) {
    writeFileSync(paths.ledgerPath, `${JSON.stringify({ runId })}\n`, 'utf8')
    utimesSync(paths.ledgerPath, at, at)
  }
  if (files.includes('journal')) {
    writeFileSync(
      paths.journalPath,
      `{"at":1,"phase":"p","kind":"failure","message":"m"}\n`,
      'utf8',
    )
    utimesSync(paths.journalPath, at, at)
  }
}

describe('passPaths', () => {
  it('resolves a relative state directory against the package, and leaves an absolute one alone', () => {
    expect(passPaths('/tmp/acc', 'run-1').ledgerPath).toBe(join('/tmp/acc', 'run-1.json'))
    expect(passPaths('.acceptance', 'run-1').dir).toBe(resolveStateDir('.acceptance'))
    expect(resolveStateDir('.acceptance')).toContain('.acceptance')
  })

  it('names both files of a pass from one id, so no caller re-spells a suffix', () => {
    const paths = passPaths('/tmp/acc', 'run-1')
    expect(paths.journalPath).toBe(join('/tmp/acc', 'run-1.journal.jsonl'))
    expect(paths.runId).toBe('run-1')
  })
})

describe('listPasses', () => {
  it('counts a pass with EITHER file, since a refused attempt has only a journal', () => {
    const dir = scratch()
    pass(dir, 'ledger-only', 1_700_000_000, ['ledger'])
    pass(dir, 'journal-only', 1_700_000_100, ['journal'])
    pass(dir, 'both', 1_700_000_200, ['ledger', 'journal'])
    expect(listPasses(dir).map((entry) => entry.runId)).toEqual([
      'both',
      'journal-only',
      'ledger-only',
    ])
  })

  it('is not fooled by the pointer or by anything else in the directory', () => {
    const dir = scratch()
    pass(dir, 'run-1', 1_700_000_000, ['ledger'])
    writeLatestPointer(passPaths(dir, 'run-1'))
    writeFileSync(join(dir, 'notes.txt'), 'scratch', 'utf8')
    expect(listPasses(dir).map((entry) => entry.runId)).toEqual(['run-1'])
  })

  it('reads a directory that does not exist as no passes', () => {
    expect(listPasses(join(scratch(), 'never-created'))).toEqual([])
  })
})

describe('findMostRecentPass', () => {
  it('answers with the pass that WROTE last, whatever its id sorts like', () => {
    // By write time rather than by id: this is the reading that has to find the pass an operator did
    // not write down, and a hand-named id ('friday-rerun') sorts nowhere near a minted timestamp.
    const dir = scratch()
    pass(dir, '20260811150000', 1_700_000_000, ['ledger', 'journal'])
    pass(dir, 'friday-rerun', 1_700_000_500, ['journal'])
    expect(findMostRecentPass(dir)).toBe('friday-rerun')
  })

  it('reaches a pass that recorded no fact, which the `latest` pointer deliberately cannot', () => {
    // The report an operator asks for most: the attempt they just watched a prerequisite refuse. It
    // wrote a journal saying why and never opened a ledger, so it never claimed the pointer.
    const dir = scratch()
    pass(dir, 'half-built', 1_700_000_000, ['ledger', 'journal'])
    writeLatestPointer(passPaths(dir, 'half-built'))
    pass(dir, 'refused-at-preflight', 1_700_000_900, ['journal'])
    expect(findMostRecentPass(dir)).toBe('refused-at-preflight')
    expect(readLatestRunId(dir)).toBe('half-built')
  })

  it('answers null for a directory holding no pass', () => {
    expect(findMostRecentPass(scratch())).toBeNull()
  })
})

describe('the latest pointer', () => {
  it('records the id and the ledger it resolves to, from one identity', () => {
    const dir = scratch()
    const paths = passPaths(dir, 'run-1')
    writeLatestPointer(paths)
    expect(readLatestRunId(dir)).toBe('run-1')
    expect(latestPointerPath(dir)).toBe(join(dir, 'latest.json'))
  })

  it('treats an absent, malformed or id-less pointer as no pass', () => {
    const dir = scratch()
    expect(readLatestRunId(dir)).toBeNull()
    writeFileSync(latestPointerPath(dir), 'not json', 'utf8')
    expect(readLatestRunId(dir)).toBeNull()
    writeFileSync(latestPointerPath(dir), JSON.stringify({ ledger: 'x' }), 'utf8')
    expect(readLatestRunId(dir)).toBeNull()
  })
})
