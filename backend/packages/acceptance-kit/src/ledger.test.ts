import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findPassesNaming,
  type LedgerFacts,
  type LedgerSlot,
  LedgerStore,
  readLedger,
  recordsFacts,
  resolveRunId,
} from './ledger.js'
import { readLatestRunId } from './passFiles.js'
import type { SuiteIdentity } from './suiteIdentity.js'

// What is pinned here is the part a SUITE cannot see: this store is generic over somebody else's
// fact type, so the properties worth testing are the ones that hold whatever that type is. The
// platform's own suite covers the World-shaped half; these cover the rules that survive it being
// replaced.

type Facts = LedgerFacts & {
  service: { id: string } | null
  run: { taskId: string } | null
  /** A slot that is NOT a created thing, which is the case `recordsFacts` exists to keep separable. */
  startedAt: number | null
}

const SLOTS: Record<Exclude<keyof Facts, 'runId'>, LedgerSlot> = {
  service: 'created',
  run: 'created',
  startedAt: 'bookkeeping',
}

const identity: SuiteIdentity = {
  name: '@acme/acceptance',
  runCommand: 'pnpm --filter @acme/acceptance run acceptance',
  runIdVariable: 'ACME_RUN_ID',
  baseUrlVariable: 'ACME_BASE_URL',
  configFile: 'acceptance/.env',
}

function empty(runId: string): Facts {
  return { runId, service: null, run: null, startedAt: null }
}

function coerce(value: unknown): Facts | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.runId !== 'string' || !record.runId) return null
  return {
    runId: record.runId,
    service: (record.service as Facts['service']) ?? null,
    run: (record.run as Facts['run']) ?? null,
    startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
  }
}

function store(stateDir: string, runId: string): LedgerStore<Facts> {
  return new LedgerStore<Facts>({ stateDir, runId, empty, coerce, identity })
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'cf-kit-ledger-'))
}

describe('recordsFacts', () => {
  it('counts what the pass CREATED and ignores what it merely wrote down', () => {
    // The distinction the whole classification exists for, and it is invisible until a ledger
    // carries its first non-id field: scanning the object instead, a `startedAt` reports every
    // pass (a fresh attempt a prerequisite refused included) as having created something, and the
    // closing words then tell that operator their state is still there to inspect.
    expect(recordsFacts({ ...empty('r'), startedAt: 1 }, SLOTS)).toBe(false)
    expect(recordsFacts({ ...empty('r'), service: { id: 'svc_1' } }, SLOTS)).toBe(true)
  })

  it('reads an undefined slot as absent, which is what a hand-edited ledger produces', () => {
    const handEdited = { ...empty('r'), service: undefined } as unknown as Facts
    expect(recordsFacts(handEdited, SLOTS)).toBe(false)
  })
})

describe('resolveRunId', () => {
  it("reads the SUITE's own variable, not a name this kit picked", () => {
    expect(resolveRunId({ ACME_RUN_ID: 'run-7' }, scratch(), identity)).toBe('run-7')
    // Another suite's variable is nothing to this one: read as a pin, a pass would silently resume
    // somebody else's id.
    expect(resolveRunId({ ACCEPTANCE_RUN_ID: 'run-7' }, scratch(), identity)).not.toBe('run-7')
  })

  it("refuses 'latest' when no pass has recorded a fact, naming the variable to unset", () => {
    // The two intents are opposite: an operator asking to continue must never be handed a fresh
    // pass that creates real state and spends real money.
    expect(() => resolveRunId({ ACME_RUN_ID: 'latest' }, scratch(), identity)).toThrow(
      /ACME_RUN_ID/,
    )
  })

  it('mints an id that is safe in a filename, since it names the two files of a pass', () => {
    expect(resolveRunId({}, scratch(), identity)).toMatch(/^[0-9]+$/)
  })
})

describe('LedgerStore', () => {
  it('persists every patch synchronously, because the process it protects against dies mid-run', () => {
    const dir = scratch()
    store(dir, 'run-1').patch({ run: { taskId: 'tsk_1' } })
    expect(coerce(JSON.parse(readFileSync(join(dir, 'run-1.json'), 'utf8')))?.run).toEqual({
      taskId: 'tsk_1',
    })
  })

  it('refuses a ledger whose own run id disagrees with its FILE NAME', () => {
    // Neither answer is safe to guess: adopting the contents files this pass's work under records
    // another pass created, and discarding them overwrites what may be the last copy.
    const dir = scratch()
    writeFileSync(join(dir, 'run-2.json'), JSON.stringify(empty('run-elsewhere')), 'utf8')
    expect(() => store(dir, 'run-2')).toThrow(/copied or renamed/)
  })

  it("names the suite's resume variable when a record is read too early", () => {
    // This fires when a scenario runs out of order or against a fresh ledger, and the message IS
    // the deliverable: a bare null dereference sends the reader into the kit instead.
    const missing = () => store(scratch(), 'run-3').require('service')
    expect(missing).toThrow(/ACME_RUN_ID/)
    expect(missing).toThrow(/service/)
  })

  it('claims the latest pointer on the first FACT, never on opening', () => {
    // The pass that creates nothing is the common one (a fresh attempt a prerequisite refused), and
    // pointing `latest` at it overwrites the pointer to the half-built pass whose leftovers caused
    // the refusal, leaving it reachable only by an id nobody wrote down.
    const dir = scratch()
    store(dir, 'run-with-work').patch({ service: { id: 'svc_1' } })
    store(dir, 'run-refused')
    expect(readLatestRunId(dir)).toBe('run-with-work')
  })

  it('discards a malformed ledger rather than refusing to start', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'run-4.json'), 'not json', 'utf8')
    expect(readLedger(join(dir, 'run-4.json'), coerce)).toBeNull()
    expect(store(dir, 'run-4').value).toEqual(empty('run-4'))
  })
})

describe('findPassesNaming', () => {
  function passesHolding(dir: string, ids: readonly string[], exclude: string) {
    return findPassesNaming<Facts>({
      stateDir: dir,
      ids,
      exclude,
      coerce,
      holds: (facts) => (facts.service ? [facts.service.id] : []),
    })
  }

  it('answers PER PASS, because leftovers routinely span two and no single resume continues both', () => {
    const dir = scratch()
    store(dir, 'run-a').patch({ service: { id: 'svc_1' } })
    store(dir, 'run-b').patch({ service: { id: 'svc_2' } })
    expect(passesHolding(dir, ['svc_1', 'svc_2'], 'run-now')).toEqual([
      { runId: 'run-a', ids: ['svc_1'] },
      { runId: 'run-b', ids: ['svc_2'] },
    ])
  })

  it('never offers the asking pass, and never a ledger that disagrees with its file name', () => {
    const dir = scratch()
    store(dir, 'run-a').patch({ service: { id: 'svc_1' } })
    writeFileSync(
      join(dir, 'run-copied.json'),
      JSON.stringify({ ...empty('run-a'), service: { id: 'svc_1' } }),
      'utf8',
    )
    // A copy is not a resume target: its stated id names a pass whose own ledger is elsewhere, so
    // resuming what it advertises would start empty and re-create everything.
    expect(passesHolding(dir, ['svc_1'], 'run-a')).toEqual([])
  })
})
