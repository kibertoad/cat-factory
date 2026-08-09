import { describe, expect, it } from 'vitest'
import {
  advisoryNotes,
  blockingResults,
  formatPreflightFailure,
  formatPreflightLine,
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
  remedy: 'wire the thing',
}
const unreadable: PrerequisiteVerdict = {
  status: 'unknown',
  probeFailure: 'the app API answered 403',
  remedy: 'run the deployment open',
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

  it('reports each result as it lands, so a slow probe is not a silent one', async () => {
    const seen: string[] = []
    await runPreflight([prerequisite('a', 'required', satisfied)], undefined, (result) =>
      seen.push(result.id),
    )
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
