import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Journal } from './journal.js'
import { type LedgerFacts, LedgerStore } from './ledger.js'
import { OperatorRefusal } from './operatorText.js'
import { closingWords, describeStartupFailure, runPass } from './pass.js'
import type { ScenarioOutcome } from './scenarioRunner.js'
import type { SuiteIdentity } from './suiteIdentity.js'

// A pass is the one thing here an operator reads end to end, so what is pinned is what it OWES
// them: the resume before anything runs, the verdict at the end, and a report that survives the
// pass's own machinery breaking. The scenario loop itself is `scenarioRunner.test.ts`.

const identity: SuiteIdentity = {
  name: 'acme-acceptance',
  runCommand: 'pnpm --filter @acme/acceptance run acceptance',
  runIdVariable: 'ACME_RUN_ID',
  baseUrlVariable: 'ACME_BASE_URL',
  configFile: 'acceptance/.env',
  statusCommand: (runId) => `pnpm --filter @acme/acceptance run status ${runId}`,
  resetCommand: (runId) => `pnpm --filter @acme/acceptance run reset ${runId}`,
}

type Facts = LedgerFacts & { service: string | null }

function passUnder(options: {
  scenarios: Parameters<typeof runPass>[0]['scenarios']
  created?: boolean
  gate?: () => Promise<void>
  recordsFacts?: () => boolean
}) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-kit-pass-'))
  const ledger = new LedgerStore<Facts>({
    stateDir: dir,
    runId: 'run-1',
    empty: (runId) => ({ runId, service: null }),
    coerce: () => null,
    identity,
  })
  const journal = new Journal(dir, 'run-1')
  const lines: string[] = []
  return {
    journal,
    lines,
    run: () =>
      runPass<Facts>({
        identity,
        target: 'https://deployment.invalid',
        ledger,
        journal,
        scenarios: options.scenarios,
        gate: options.gate ?? (() => Promise.resolve()),
        log: (message) => lines.push(message),
        recordsFacts: options.recordsFacts ?? (() => options.created ?? false),
      }),
  }
}

describe('runPass', () => {
  it('prints the resume BEFORE the first scenario, since a pass that dies late has no other way back', () => {
    const pass = passUnder({ scenarios: [] })
    return pass.run().then(() => {
      const banner = pass.lines[0] ?? ''
      expect(banner).toContain('run-1')
      // Rendered for the shell that will receive it, and naming the suite's OWN variable.
      expect(banner).toContain('ACME_RUN_ID')
      expect(banner).toContain('https://deployment.invalid')
    })
  })

  it('answers 0 only when every scenario passed, and files the failure in the journal', async () => {
    const pass = passUnder({
      scenarios: [
        {
          id: '01-x',
          title: 'fails',
          gated: false,
          run: () => Promise.reject(new Error('the coder never started')),
        },
      ],
    })
    expect(await pass.run()).toBe(1)
    const journal = readFileSync(pass.journal.path, 'utf8')
    expect(journal).toContain('"kind":"failure"')
    // The phase is entered by the pass, in the one place that knows a scenario is starting, so
    // every line the scenario wrote is filed under it.
    expect(journal).toContain('"phase":"01-x"')
  })

  it('reports a bug in the pass ITSELF without losing the run id or the resume', async () => {
    // The exit whose own report may be the thing that broke: what it owes the operator is the
    // facts, rather than advice derived from a report it may not be able to make. A gate or a
    // scenario that throws is an ordinary failure and never lands here, so what is driven is the
    // ledger read the closing words make, which is reached after an afternoon of real spend.
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {})
    const pass = passUnder({
      scenarios: [{ id: '01-x', title: 'x', gated: false, run: () => Promise.resolve() }],
      recordsFacts: () => {
        throw new TypeError('the ledger is gone')
      },
    })
    expect(await pass.run()).toBe(1)
    const report = printed.mock.calls.map((call) => String(call[0])).join('\n')
    expect(report).toContain('SUITE ITSELF')
    expect(report).toContain('run-1')
    // The paths are named unconditionally here, unlike in the closing words.
    expect(report).toContain(pass.journal.path)
    printed.mockRestore()
  })
})

describe('closingWords', () => {
  const failed: readonly ScenarioOutcome[] = [
    { id: '01-x', status: 'failed', steps: 1, elapsedMs: 10, failure: null },
  ]

  it('offers a resume only when the pass actually created something', () => {
    // The commonest failure of all is a prerequisite refusing a FRESH attempt, which by
    // construction created nothing: offered a resume there, an operator continues an empty ledger,
    // and told their state is still there they go looking for a run that does not exist.
    expect(closingWords(failed, 'run-1', false, identity)).toContain('created nothing')
    // The OFFER, which is an indented command line, not the words "nothing to resume".
    expect(closingWords(failed, 'run-1', false, identity)).not.toContain('  resume:')
    expect(closingWords(failed, 'run-1', true, identity)).toContain('  resume:')
  })

  it('offers only the commands the suite HAS', () => {
    // A kit that invented a status or reset command would print an operator a line that does not
    // run. Absent, the closing words say less rather than something untrue.
    const bare: SuiteIdentity = { ...identity, statusCommand: undefined, resetCommand: undefined }
    const words = closingWords(failed, 'run-1', true, bare)
    expect(words).toContain('  resume:')
    expect(words).not.toContain('report:')
    expect(words).not.toContain('start over')
  })

  it('says nothing is left to run when every scenario passed', () => {
    const passed: readonly ScenarioOutcome[] = [
      { id: '01-x', status: 'passed', steps: 2, elapsedMs: 10, failure: null },
    ]
    expect(closingWords(passed, 'run-1', true, identity)).toContain('complete')
  })
})

describe('describeStartupFailure', () => {
  it('prints a refusal WHOLE, with no preamble and no frames', () => {
    // It was authored for this reader: a stack over a fourteen-item remedy list buries the last of
    // them, and the preamble accuses the suite of a bug it did not have.
    const rendered = describeStartupFailure(new OperatorRefusal('set ACME_BASE_URL'), 'a bug')
    expect(rendered).toBe('set ACME_BASE_URL')
  })

  it('says outright that anything else is a bug, and keeps the location', () => {
    const rendered = describeStartupFailure(
      new TypeError('x is not a function'),
      'a bug in the suite',
    )
    expect(rendered).toContain('a bug in the suite')
    expect(rendered).toContain('pass.test.ts')
  })
})
