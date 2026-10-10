import { describe, expect, it } from 'vitest'
import {
  advisoryNotes,
  blockingResults,
  createPrerequisiteGate,
  formatPreflightFailure,
  formatPreflightLine,
  formatPrerequisiteFailure,
  formatRemedy,
  type PreflightReport,
  type Prerequisite,
  type PrerequisiteResult,
  type PrerequisiteVerdict,
  runPreflight,
  unknown,
} from './preflight.js'

// The gate is the one part of this suite whose failure is silent: a check that reports green
// having concluded nothing lets an afternoon of real spend proceed against a deployment that was
// always going to fail at the merge. So what is pinned here is the DISPOSITION logic, not the
// probes: that an unreadable answer blocks, that an advisory never does, and that every failing
// prerequisite reaches the message rather than only the first.

const check =
  (verdict: PrerequisiteVerdict): Prerequisite<void>['check'] =>
  async () =>
    verdict

function prerequisite(
  id: string,
  disposition: 'required' | 'advisory',
  verdict: PrerequisiteVerdict,
): Prerequisite<void> {
  return { id, what: `what ${id} guarantees`, disposition, check: check(verdict) }
}

const satisfied: PrerequisiteVerdict = { status: 'satisfied', detail: 'all good' }
const unsatisfied: PrerequisiteVerdict = {
  status: 'unsatisfied',
  problem: 'the thing is not wired',
  remedy: {
    steps: ['wire the thing', 'restart it'],
    commands: [{ run: 'curl -sS http://127.0.0.1:8787/health', purpose: 'confirm it came back' }],
    docs: 'backend/docs/wiring.md',
  },
}
const unreadable: PrerequisiteVerdict = {
  status: 'unknown',
  probeFailure: 'the app API answered 403',
  remedy: { steps: ['run the deployment open'] },
}

describe('runPreflight', () => {
  it('evaluates every prerequisite rather than stopping at the first failure', async () => {
    const report = await runPreflight(
      [
        prerequisite('a', 'required', unsatisfied),
        prerequisite('b', 'required', unsatisfied),
        prerequisite('c', 'required', satisfied),
      ],
      undefined,
    )
    // The rule this pins: a pass costs an afternoon, so learning about the second problem on
    // tomorrow's attempt wastes a day per problem.
    expect(report.results.map((result) => result.id)).toEqual(['a', 'b', 'c'])
    expect(blockingResults(report)).toHaveLength(2)
  })

  it('turns a THROWN probe into an unknown verdict instead of losing the other results', async () => {
    const report = await runPreflight(
      [
        {
          id: 'explodes',
          what: 'nothing',
          disposition: 'required',
          check: () => Promise.reject(new Error('connect ECONNREFUSED')),
        },
        prerequisite('after', 'required', satisfied),
      ],
      undefined,
    )
    expect(report.results[0]?.verdict.status).toBe('unknown')
    expect(report.results[1]?.verdict.status).toBe('satisfied')
    expect(formatPreflightFailure(report)).toContain('ECONNREFUSED')
  })

  it('reads the whole cause chain of a thrown probe, not undici’s contentless wrapper', async () => {
    // The regression this pins is the one the gate actually shipped with: a deployment that was not
    // running reported `the check threw: fetch failed`, which is the SAME string a DNS typo and an
    // untrusted certificate produce, under a remedy listing all three. Shaped exactly as undici
    // throws it, because the informative link is the one hanging off `.cause`.
    const report = await runPreflight(
      [
        {
          id: 'health',
          what: 'nothing',
          disposition: 'required',
          check: () =>
            Promise.reject(
              new TypeError('fetch failed', {
                cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), {
                  code: 'ECONNREFUSED',
                }),
              }),
            ),
        },
      ],
      undefined,
      { probe: { subject: 'the cat-factory backend', target: 'http://127.0.0.1:8787' } },
    )
    const failure = formatPreflightFailure(report) ?? ''
    expect(failure).toContain('connect ECONNREFUSED 127.0.0.1:8787')
    // The classified cause reaches the SUMMARY line, which is the only part the streamed
    // one-per-prerequisite output prints.
    expect(failure).toContain('could not connect (refused)')
    // And the remedy is now the one for THIS cause, naming the address, rather than three guesses.
    expect(failure).toContain('Nothing is listening at http://127.0.0.1:8787')
    expect(failure).not.toContain('scoped below')
  })

  it('reports each result as it lands, so a slow probe is not a silent one', async () => {
    const seen: string[] = []
    await runPreflight([prerequisite('a', 'required', satisfied)], undefined, {
      onResult: (result) => seen.push(result.id),
    })
    expect(seen).toEqual(['a'])
  })

  it("classifies a check's throw against the HOST that check names, not the deployment", async () => {
    // A check reaching a VCS provider's API or an environment backend directly cannot be described
    // against the pass-level context, because a value cannot be true for two hosts. Before the
    // per-check field the only honest option was to catch its own throws and hand-build the verdict,
    // which puts kernel's classification out of reach of exactly the checks that reach the least
    // predictable hosts.
    const report = await runPreflight(
      [
        {
          id: 'kargo-credential',
          what: 'the Kargo API accepts our token',
          disposition: 'required',
          probe: { subject: 'the Kargo API', target: 'https://kargo.example' },
          check: () =>
            Promise.reject(
              new TypeError('fetch failed', {
                cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), {
                  code: 'ECONNREFUSED',
                }),
              }),
            ),
        },
      ],
      undefined,
      { probe: { subject: 'the cat-factory backend', target: 'http://127.0.0.1:8787' } },
    )
    const failure = formatPreflightFailure(report) ?? ''
    expect(failure).toContain('https://kargo.example')
    // WHOLE rather than merged: a remedy offering `curl <the deployment>/health` for a failure that
    // never went near it sends an operator to check the one thing this failure has not questioned.
    expect(failure).not.toContain('127.0.0.1:8787')
  })
})

describe('the verdict constructors', () => {
  it('builds an `unknown` verdict, which suites were spelling out by hand', async () => {
    // Rule 2 makes `unknown` the state a suite reaches most often BY HAND (a check reaching a host
    // the runner cannot classify for it catches its own throw), and it shipped as the one state with
    // no constructor beside its two siblings.
    const remedy = { steps: ['Check the Kargo API is reachable.'] }
    const report = await runPreflight(
      [
        {
          id: 'kargo',
          what: 'Kargo answers',
          disposition: 'required',
          check: async () => unknown('the Kargo API did not answer within 10s', remedy),
        },
      ],
      undefined,
    )
    expect(report.results[0]?.verdict).toEqual({
      status: 'unknown',
      probeFailure: 'the Kargo API did not answer within 10s',
      remedy,
    })
    // An unreadable REQUIRED prerequisite blocks, and says the probe failed rather than the thing.
    expect(blockingResults(report)).toHaveLength(1)
  })
})

describe('disposition', () => {
  it('blocks on an UNREADABLE required prerequisite, and says the probe failed', async () => {
    // The distinction that matters: reporting an unreadable answer as "unmet" sends someone to
    // fix a model catalog when the real problem is that the request was refused.
    const report = await runPreflight([prerequisite('vcs', 'required', unreadable)], undefined)
    const failure = formatPreflightFailure(report)
    expect(failure).toContain('could not read an answer')
    expect(failure).toContain('NOT a verdict')
    expect(failure).toContain('run the deployment open')
  })

  it('never blocks on an advisory, but still states it', async () => {
    const report = await runPreflight(
      [
        prerequisite('catalog', 'advisory', unsatisfied),
        prerequisite('key', 'required', satisfied),
      ],
      undefined,
    )
    expect(formatPreflightFailure(report)).toBeNull()
    expect(advisoryNotes(report).map((note) => note.id)).toEqual(['catalog'])
  })

  it('carries advisory notes into a refusal caused by something else', async () => {
    const report = await runPreflight(
      [
        prerequisite('catalog', 'advisory', unsatisfied),
        prerequisite('key', 'required', unsatisfied),
      ],
      undefined,
    )
    // A pass about to be refused is exactly when the other things worth knowing are cheapest to say.
    expect(formatPreflightFailure(report)).toContain('do not block')
  })
})

describe('formatPreflightFailure', () => {
  it('names the remedy for every blocking prerequisite', async () => {
    const report = await runPreflight(
      [prerequisite('a', 'required', unsatisfied), prerequisite('b', 'required', unreadable)],
      undefined,
    )
    const failure = formatPreflightFailure(report) ?? ''
    expect(failure).toContain('wire the thing')
    expect(failure).toContain('run the deployment open')
    expect(failure).toContain('Nothing was created')
  })

  it('is null when every required prerequisite holds', async () => {
    const report = await runPreflight([prerequisite('a', 'required', satisfied)], undefined)
    expect(formatPreflightFailure(report)).toBeNull()
  })

  it('carries the commands into the refusal, which is the only place a resumed pass reads', async () => {
    // A pass resumed into scenario 02 never runs scenario 00, so this one string is the whole report.
    // Losing the commands here would leave the instructions readable only on a fresh pass.
    const report = await runPreflight([prerequisite('a', 'required', unsatisfied)], undefined)
    expect(formatPreflightFailure(report)).toContain('curl -sS http://127.0.0.1:8787/health')
  })
})

describe('formatRemedy', () => {
  it('numbers the steps and prints each command under its purpose', () => {
    const rendered = formatRemedy({
      steps: ['first', 'second'],
      commands: [{ run: 'echo hi', purpose: 'say hi' }],
      docs: 'docs/x.md',
    })
    // The purpose is a shell COMMENT above the command rather than prose beside it, so the whole
    // block can be selected and pasted and is still a valid (and self-documenting) script.
    expect(rendered).toContain('  1. first')
    expect(rendered).toContain('  2. second')
    expect(rendered).toContain('    # say hi\n    echo hi')
    expect(rendered).toContain('Docs: docs/x.md')
  })

  it('prints no command heading for a fix that has none', () => {
    // Minting a token and raising a budget are console actions. An empty "Run:" under one reads
    // as a command that failed to render, which is worse than the absence it is reporting.
    const rendered = formatRemedy({ steps: ['open the settings screen'] })
    expect(rendered).not.toContain('Run:')
    expect(rendered).toBe('  1. open the settings screen')
  })
})

describe('formatPrerequisiteFailure', () => {
  it('states what the prerequisite guarantees, what is wrong, and how to fix it', () => {
    const rendered = formatPrerequisiteFailure({
      id: 'vcs',
      what: 'what vcs guarantees',
      disposition: 'required',
      verdict: unsatisfied,
    })
    expect(rendered).toContain('vcs (what vcs guarantees)')
    expect(rendered).toContain('the thing is not wired')
    expect(rendered).toContain('Fix:')
    expect(rendered).toContain('1. wire the thing')
  })

  it('keeps an unreadable probe distinguishable from an unmet prerequisite', () => {
    const rendered = formatPrerequisiteFailure({
      id: 'vcs',
      what: 'what vcs guarantees',
      disposition: 'required',
      verdict: unreadable,
    })
    expect(rendered).toContain('NOT a verdict')
    expect(rendered).toContain('run the deployment open')
  })
})

describe('formatPreflightLine', () => {
  it('distinguishes the three states at a glance', () => {
    const line = (verdict: PrerequisiteVerdict) =>
      formatPreflightLine({ id: 'x', what: 'w', disposition: 'required', verdict })
    expect(line(satisfied)).toContain('ok')
    expect(line(unsatisfied)).toContain('FAIL')
    expect(line(unreadable)).toContain('could not be checked')
  })
})

describe('createPrerequisiteGate', () => {
  // Freshness is rule 0: a pass takes an afternoon, so a workspace that goes over budget between two
  // scenarios must be refused before the next one spends. The single exception is the seam between
  // the preflight REPORT and the first gated scenario, which are the same evaluation twice with
  // nothing in between (~14 duplicate round trips, every verdict line printed to the operator twice,
  // and two copies of each entry in the journal `status` reduces).

  function report(...results: readonly PrerequisiteResult[]): PreflightReport {
    return { results }
  }

  const green = report({
    id: 'a',
    what: 'what a guarantees',
    disposition: 'required',
    verdict: satisfied,
  })
  const red = report({
    id: 'a',
    what: 'what a guarantees',
    disposition: 'required',
    verdict: unsatisfied,
  })

  function counting(next: () => PreflightReport): {
    gate: ReturnType<typeof createPrerequisiteGate>
    evaluations: () => number
  } {
    let evaluations = 0
    const gate = createPrerequisiteGate(async () => {
      evaluations += 1
      return next()
    })
    return { gate, evaluations: () => evaluations }
  }

  it('evaluates for itself when nothing was offered', async () => {
    const { gate, evaluations } = counting(() => green)

    await gate.assert()

    expect(evaluations()).toBe(1)
  })

  it('consumes the report the preflight scenario just paid for, rather than repeating it', async () => {
    const { gate, evaluations } = counting(() => green)

    await gate.evaluate()
    await gate.assert()

    expect(evaluations()).toBe(1)
  })

  it('offers it EXACTLY once, so the next scenario is gated on a fresh read', async () => {
    // The gate after the first is separated from it by a scenario that spent an afternoon, which is
    // precisely the one that must not reuse anything.
    const { gate, evaluations } = counting(() => green)

    await gate.evaluate()
    await gate.assert()
    await gate.assert()
    await gate.assert()

    expect(evaluations()).toBe(3)
  })

  it('does not leave a refused report standing for whatever asks next', async () => {
    // A gate that threw and left its report behind would answer the NEXT scenario from a reading
    // that already refused, which is a stale verdict in both directions.
    const answers = [red, green]
    const { gate, evaluations } = counting(() => answers.shift() ?? green)

    await gate.evaluate()
    await expect(gate.assert()).rejects.toThrow(/not ready for an acceptance pass/)
    await gate.assert()

    expect(evaluations()).toBe(2)
  })

  it('throws the WHOLE refusal, which is what an operator acts on', async () => {
    const { gate } = counting(() => red)

    await expect(gate.assert()).rejects.toThrow(/wire the thing/)
  })
})
