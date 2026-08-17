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
  target?: string
  onSettled?: (outcomes: readonly ScenarioOutcome[]) => Promise<readonly string[]>
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
        target: options.target ?? 'https://deployment.invalid',
        ledger,
        journal,
        scenarios: options.scenarios,
        gate: options.gate ?? (() => Promise.resolve()),
        log: (message) => lines.push(message),
        recordsFacts: options.recordsFacts ?? (() => options.created ?? false),
        ...(options.onSettled ? { onSettled: options.onSettled } : {}),
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

  it('SCRUBS the target, since the banner heads a log that gets pasted into an issue', async () => {
    // A base URL may legitimately carry userinfo and no URL policy rejects it. Scrubbing was the
    // caller's job for one commit, which makes it a rule every consumer has to know rather than a
    // property of the kit: an afternoon-long pass is piped to a file, and this is its first line.
    const pass = passUnder({
      scenarios: [],
      target: 'https://svc:hunter2@backend.example.com',
    })
    await pass.run()
    const banner = pass.lines[0] ?? ''
    expect(banner).not.toContain('hunter2')
    expect(banner).toContain('backend.example.com')
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

  it('folds what `onSettled` released INTO the closing words rather than after them', async () => {
    // The reason the seam exists at all. Wrapping `runPass` puts the reclaim block after the closing
    // words that were written to be the last thing an operator reads, and on an afternoon-long pass
    // piped to a file the tail is what gets read.
    const pass = passUnder({
      scenarios: [{ id: '01-x', title: 'x', gated: false, run: () => Promise.resolve() }],
      onSettled: async () => ['1 resource may STILL BE RUNNING: env-42'],
    })
    expect(await pass.run()).toBe(0)
    const tail = pass.lines.at(-1) ?? ''
    expect(tail).toContain('env-42')
    expect(tail).toContain('The pass is complete')
    expect(tail.indexOf('env-42')).toBeLessThan(tail.indexOf('The pass is complete'))
  })

  it('runs `onSettled` on the FAILURE path, where a leaked resource matters most', async () => {
    const released: string[] = []
    const pass = passUnder({
      created: true,
      scenarios: [
        { id: '01-x', title: 'x', gated: false, run: () => Promise.reject(new Error('boom')) },
      ],
      onSettled: async (outcomes) => {
        released.push(outcomes[0]?.status ?? '(none)')
        return []
      },
    })
    expect(await pass.run()).toBe(1)
    expect(released).toEqual(['failed'])
  })

  it('RENDERS a throw out of `onSettled` instead of replacing the scenario failure with it', async () => {
    // Why it is not a `try/finally` at the call site: the scenario's own report is the more valuable
    // of the two, and a reclaim that dies must not take it down. The throw becomes a line saying the
    // resource may still be standing, which is the state an operator has to act on anyway.
    const pass = passUnder({
      created: true,
      scenarios: [
        {
          id: '01-x',
          title: 'x',
          gated: false,
          run: () => Promise.reject(new Error('the coder never started')),
        },
      ],
      onSettled: () => Promise.reject(new TypeError('the provider client is gone')),
    })
    expect(await pass.run()).toBe(1)
    const output = pass.lines.join('\n')
    expect(output).toContain('the coder never started')
    expect(output).toContain('may still be running')
    expect(output).toContain('the provider client is gone')
    expect(output).toContain('  resume:')
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
