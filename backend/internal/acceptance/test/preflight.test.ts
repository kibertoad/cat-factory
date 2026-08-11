import { describe, expect, it } from 'vitest'
import {
  advisoryNotes,
  blockingResults,
  formatPreflightFailure,
  formatPreflightLine,
  formatPrerequisiteFailure,
  formatRemedy,
  type Prerequisite,
  type PrerequisiteVerdict,
  runPreflight,
} from '../src/preflight.ts'
import { PREREQUISITES } from '../src/prerequisites.ts'

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
    // A pass resumed into spec 02 never runs spec 00, so this one string is the whole report.
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

describe('the registry', () => {
  it('gives every prerequisite a distinct id, which spec 00 names its tests from', () => {
    const ids = PREREQUISITES.map((prerequisite) => prerequisite.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('states what each prerequisite guarantees, since that is what a failure is read as', () => {
    for (const entry of PREREQUISITES) {
      expect(entry.what.length, `${entry.id} has no 'what'`).toBeGreaterThan(0)
    }
  })

  it('keeps advisories to the ones a pass can genuinely proceed through', () => {
    // Derived from the registry rather than pinned to a number: the point is that `advisory` stays
    // rare and deliberate, not that it stays at today's count. A prerequisite whose failure ends
    // the pass an hour later belongs on the required side however awkward that is.
    const advisory = PREREQUISITES.filter((entry) => entry.disposition === 'advisory')
    expect(advisory.map((entry) => entry.id)).toEqual(['pipeline-catalog'])
  })
})
