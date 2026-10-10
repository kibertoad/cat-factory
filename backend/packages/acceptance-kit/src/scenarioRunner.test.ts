import { describe, expect, it } from 'vitest'
import {
  formatScenarioSummary,
  GATE_STEP,
  runScenarios,
  type Scenario,
  type ScenarioFailure,
  type ScenarioRunnerDeps,
  scenariosExitCode,
} from './scenarioRunner.js'

// This is the driver that replaced vitest, so what is pinned here is everything the framework used to
// be responsible for and this loop now is. Every one of these was a live bug at some point in the
// vitest shape, which is why they are properties rather than a smoke test: the ORDER (a sequencer
// reordering from a results cache ran the last scenario first and stopped the pass on an empty
// ledger), the BAIL (the second failure is the first one's shadow, and continuing spends real model
// money on work whose input never got created), the GATE before every scenario (a resumed pass never
// executes the preflight scenario, so a gate only the first one runs is a gate the resume path
// skips), and the EXIT CODE (a pass that stopped early is not a pass).

type Recorded = {
  deps: ScenarioRunnerDeps
  /** Every seam call, in order: `open:<id>`, `gate`, `log:<line>`, `fail`. */
  calls: string[]
  logs: string[]
  failures: ScenarioFailure[]
}

function recorder(options: { gateThrows?: string } = {}): Recorded {
  const calls: string[] = []
  const logs: string[] = []
  const failures: ScenarioFailure[] = []
  let clock = 0
  return {
    calls,
    logs,
    failures,
    deps: {
      open: (scenario) => calls.push(`open:${scenario.id}`),
      // Neither `gate` nor `onFailure` is told WHICH scenario, so what a gate call can be attributed
      // to here is the `open:` immediately before it. That is the seam's contract rather than a
      // limitation of the recorder: there is one gate and it cannot vary per scenario, and the
      // journal is already in the failing scenario's phase.
      gate: async () => {
        calls.push('gate')
        if (options.gateThrows) throw new Error(options.gateThrows)
      },
      log: (message) => {
        calls.push(`log:${message}`)
        logs.push(message)
      },
      onFailure: (failure) => {
        calls.push('fail')
        failures.push(failure)
      },
      // Monotonic and deterministic, so a summary can be asserted on: one tick per reading.
      now: () => (clock += 1000),
    },
  }
}

function scenario(
  id: string,
  options: { gated?: boolean; steps?: readonly string[] } = {},
): Scenario {
  return {
    id,
    title: `the ${id} scenario`,
    gated: options.gated ?? false,
    async run(step) {
      for (const name of options.steps ?? ['a step']) {
        await step(name, async () => undefined)
      }
    },
  }
}

function failing(id: string, options: { at: string; message: string; gated?: boolean }): Scenario {
  return {
    id,
    title: `the ${id} scenario`,
    gated: options.gated ?? false,
    async run(step) {
      await step('a step that works', async () => undefined)
      await step(options.at, async () => {
        throw new Error(options.message)
      })
      await step('a step after the failure', async () => undefined)
    },
  }
}

describe('runScenarios', () => {
  it('runs them in the order given, which is the whole ordering mechanism', async () => {
    const recorded = recorder()

    const outcomes = await runScenarios(recorded.deps, [
      scenario('00-first'),
      scenario('01-second'),
      scenario('02-third'),
    ])

    expect(outcomes.map((outcome) => outcome.id)).toEqual(['00-first', '01-second', '02-third'])
    expect(recorded.calls.filter((call) => call.startsWith('open:'))).toEqual([
      'open:00-first',
      'open:01-second',
      'open:02-third',
    ])
    expect(outcomes.every((outcome) => outcome.status === 'passed')).toBe(true)
  })

  it('stops at the first failure and reports the rest as NOT RUN, never as passed', async () => {
    const recorded = recorder()

    const outcomes = await runScenarios(recorded.deps, [
      scenario('00-first'),
      failing('01-second', { at: 'the step that broke', message: 'the run never merged' }),
      scenario('02-third'),
    ])

    expect(outcomes.map((outcome) => `${outcome.id}:${outcome.status}`)).toEqual([
      '00-first:passed',
      '01-second:failed',
      '02-third:not-run',
    ])
    // Never opened, so nothing was dispatched and no journal phase was entered for it.
    expect(recorded.calls).not.toContain('open:02-third')
  })

  it('names the step that failed, and how far the scenario got', async () => {
    const recorded = recorder()

    const outcomes = await runScenarios(recorded.deps, [
      failing('01-second', { at: 'the step that broke', message: 'the run never merged' }),
    ])

    expect(outcomes[0]?.failure?.step).toBe('the step that broke')
    // One step finished before the throw; the one after it never ran.
    expect(outcomes[0]?.steps).toBe(1)
    expect(recorded.failures[0]?.message).toContain('the run never merged')
    expect(recorded.logs.join('\n')).toContain('the run never merged')
  })

  it('carries the thrown message VERBATIM, because it is the deliverable', async () => {
    // Every refusal this suite raises is written for an operator: the preflight's numbered remedies,
    // a deadline's last observation, a graded list of claims. A driver that summarised one would
    // throw away the reason the suite is worth running.
    const refusal =
      'the backend feature run: 2 of 5 claims failed.\n' +
      '  FAIL at least one environment came up: none ready; 1 failed'
    const recorded = recorder()

    await runScenarios(recorded.deps, [
      {
        id: '02-feature',
        title: 'a feature',
        gated: false,
        run: async (step) =>
          step('grades the evidence', async () => {
            throw new Error(refusal)
          }),
      },
    ])

    expect(recorded.failures[0]?.message).toContain(refusal)
  })

  it('does not truncate a refusal at the budget a TOAST reads', async () => {
    // The regression this guards is silent in the worst direction. A preflight naming fourteen
    // prerequisites with their numbered remedies runs to thousands of characters; rendered through
    // kernel's 400-character human budget (which is what `describeThrown` carries, for a value
    // interpolated into a sentence) an operator gets the first two prerequisites and no fix for
    // either, under a message that reads like the whole refusal.
    const long = `${'a preflight refusal. '.repeat(120)}THE LAST REMEDY`
    const recorded = recorder()

    await runScenarios(recorded.deps, [
      {
        id: '00-preflight',
        title: 'the gate',
        gated: false,
        run: async (step) =>
          step('reports every prerequisite', async () => {
            throw new Error(long)
          }),
      },
    ])

    expect(long.length).toBeGreaterThan(2000)
    expect(recorded.failures[0]?.message).toContain('THE LAST REMEDY')
  })

  it('adds the frames, so a bug in the suite is not an afternoon of guessing', async () => {
    const recorded = recorder()

    await runScenarios(recorded.deps, [
      {
        id: '02-feature',
        title: 'a feature',
        gated: false,
        run: async (step) => {
          await step('reads a report', async () => {
            // The other class of failure: not a refusal anybody wrote, and useless without a location.
            const nothing = undefined as unknown as { url: string }
            return nothing.url
          })
        },
      },
    ])

    // On the CONSOLE, and on the failure's `location` half rather than folded into its message: the
    // journal records the message alone, and six frames collapsed onto one line made `status`'s
    // answer to "where is this pass" unreadable.
    expect(recorded.failures[0]?.location).toMatch(/^\s+at /)
    expect(recorded.failures[0]?.message).not.toMatch(/\n\s+at /)
    expect(recorded.logs.join('\n')).toMatch(/\n\s+at /)
  })

  it('carries no location for a refusal that has none to give', async () => {
    // A thrown non-Error has no stack at all, and the two halves must stay honest about that: a
    // `location` invented from nothing would render an empty frame block under every such failure.
    const recorded = recorder()

    await runScenarios(recorded.deps, [
      {
        id: '02-feature',
        title: 'a feature',
        gated: false,
        run: async (step) =>
          step('reads a report', async () => {
            throw 'the deployment answered with an HTML error page'
          }),
      },
    ])

    expect(recorded.failures[0]?.message).toContain('HTML error page')
    expect(recorded.failures[0]?.location).toBeNull()
  })

  it('runs the GATE before every gated scenario, and never for the report that is the gate', async () => {
    const recorded = recorder()

    await runScenarios(recorded.deps, [
      scenario('00-preflight', { gated: false }),
      scenario('01-second', { gated: true }),
      scenario('02-third', { gated: true }),
    ])

    // Two gate calls, each immediately after its own scenario opened and before any step of it: the
    // ungated report is the one with nothing between its `open` and its first step.
    expect(recorded.calls.filter((call) => call === 'gate' || call.startsWith('open:'))).toEqual([
      'open:00-preflight',
      'open:01-second',
      'gate',
      'open:02-third',
      'gate',
    ])
  })

  it('fails the scenario when the gate refuses, before any of its steps run', async () => {
    // The refusal that saves an afternoon: an unwired deployment, a spent budget, a leftover frame.
    const recorded = recorder({ gateThrows: 'spend-budget: this workspace is over budget' })

    const outcomes = await runScenarios(recorded.deps, [
      scenario('01-second', { gated: true, steps: ['files a task'] }),
      scenario('02-third', { gated: true }),
    ])

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'not-run'])
    expect(outcomes[0]?.failure?.step).toBe(GATE_STEP)
    expect(outcomes[0]?.failure?.message).toContain('over budget')
    expect(recorded.calls).not.toContain('log:  - files a task')
  })

  it('prints each step as it STARTS, so a 40-minute one is visible while it runs', async () => {
    const recorded = recorder()

    await runScenarios(recorded.deps, [
      {
        id: '01-second',
        title: 'a scenario',
        gated: false,
        run: async (step) => {
          await step('scaffolds the backend', async () => {
            expect(recorded.logs).toContain('  - scaffolds the backend')
          })
        },
      },
    ])

    expect(recorded.logs.some((line) => line.startsWith('    ok'))).toBe(true)
  })

  it('hands a step its own return value, so a scenario can use what it produced', async () => {
    const seen: string[] = []
    const recorded = recorder()

    await runScenarios(recorded.deps, [
      {
        id: '01-second',
        title: 'a scenario',
        gated: false,
        run: async (step) => {
          const record = await step('files a task', async () => ({ taskId: 'tsk_1' }))
          seen.push(record.taskId)
        },
      },
    ])

    expect(seen).toEqual(['tsk_1'])
  })
})

describe('scenariosExitCode', () => {
  it('is 0 only when every scenario passed', async () => {
    const recorded = recorder()
    const passed = await runScenarios(recorded.deps, [scenario('00-first'), scenario('01-second')])

    expect(scenariosExitCode(passed)).toBe(0)
  })

  it('is non-zero for a pass that stopped early, whatever the unrun scenarios would have said', async () => {
    const recorded = recorder()
    const bailed = await runScenarios(recorded.deps, [
      failing('00-first', { at: 'a step', message: 'nope' }),
      scenario('01-second'),
    ])

    expect(scenariosExitCode(bailed)).toBe(1)
  })
})

describe('formatScenarioSummary', () => {
  it('says which scenario broke, at which step, and that the rest did not run', async () => {
    const recorded = recorder()
    const outcomes = await runScenarios(recorded.deps, [
      scenario('00-preflight'),
      failing('01-adopt', { at: 'scaffolds the backend', message: 'the run never merged' }),
      scenario('02-feature'),
    ])

    const summary = formatScenarioSummary(outcomes)

    expect(summary).toContain('ok       00-preflight')
    expect(summary).toContain('FAIL     01-adopt')
    expect(summary).toContain("at 'scaffolds the backend'")
    expect(summary).toContain('not run  02-feature')
    // Not a second copy of the failure: it was printed at the failure, immediately above this, and a
    // preflight refusal reprinted in full would push the summary off the screen it exists to be read
    // on.
    expect(summary).not.toContain('the run never merged')
  })
})
