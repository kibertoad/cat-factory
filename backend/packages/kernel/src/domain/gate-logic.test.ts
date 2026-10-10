import { describe, expect, it } from 'vitest'
import type { CiCheck, RepoCiStatus } from '../ports/ci-status.js'
import type {
  ReleaseEvidence,
  ReleaseHealthReport,
  ReleaseSignal,
} from '../ports/release-health.js'
import {
  aggregateCi,
  aggregateRepoCi,
  classifyReleaseHealth,
  describeFailingChecks,
  describeFailingRepos,
  describeRegressedSignals,
  headFields,
  isCiGreen,
  listFailingChecks,
  listFailingChecksAcrossRepos,
  renderReleaseEvidence,
} from './gate-logic.js'

const check = (
  status: string,
  conclusion: string | null,
  name = 'build',
  url: string | null = null,
): CiCheck => ({
  name,
  status,
  conclusion,
  url,
})

describe('aggregateCi', () => {
  it('reports `none` when there are no checks (nothing to gate)', () => {
    expect(aggregateCi([])).toBe('none')
    expect(isCiGreen('none')).toBe(true)
  })

  it('reports `success` when every completed check passed', () => {
    expect(aggregateCi([check('completed', 'success'), check('completed', 'neutral')])).toBe(
      'success',
    )
    expect(isCiGreen('success')).toBe(true)
  })

  it('treats neutral and skipped conclusions as passing', () => {
    expect(aggregateCi([check('completed', 'skipped')])).toBe('success')
  })

  it('does not fail the gate on a stale (superseded) check', () => {
    expect(aggregateCi([check('completed', 'success'), check('completed', 'stale')])).toBe(
      'success',
    )
    expect(aggregateCi([check('completed', 'stale'), check('in_progress', null)])).toBe('pending')
  })

  it('reports `pending` while a check is still running and none have failed', () => {
    expect(aggregateCi([check('completed', 'success'), check('in_progress', null)])).toBe('pending')
    expect(aggregateCi([check('queued', null)])).toBe('pending')
    expect(isCiGreen('pending')).toBe(false)
  })

  it('reports `failure` as soon as one completed check failed, even if others pend', () => {
    expect(aggregateCi([check('completed', 'failure'), check('in_progress', null)])).toBe('failure')
    expect(aggregateCi([check('completed', 'timed_out')])).toBe('failure')
    expect(aggregateCi([check('completed', 'cancelled')])).toBe('failure')
    expect(isCiGreen('failure')).toBe(false)
  })
})

describe('describeFailingChecks', () => {
  it('names the failing checks with their conclusions', () => {
    const summary = describeFailingChecks([
      check('completed', 'success', 'lint'),
      check('completed', 'failure', 'unit'),
      check('completed', 'timed_out', 'e2e'),
    ])
    expect(summary).toContain('unit (failure)')
    expect(summary).toContain('e2e (timed_out)')
    expect(summary).not.toContain('lint')
  })

  it('falls back to a generic message when nothing is conclusively failing', () => {
    expect(describeFailingChecks([check('in_progress', null)])).toBe('CI reported a failure.')
  })
})

describe('listFailingChecks', () => {
  it('returns the completed, non-passing checks as name + conclusion + url (for the UI)', () => {
    const failing = listFailingChecks([
      check('completed', 'success', 'lint'),
      check('completed', 'failure', 'unit', 'https://github.com/o/r/runs/1'),
      check('completed', 'timed_out', 'e2e'),
      check('in_progress', null, 'slow'),
    ])
    expect(failing).toEqual([
      { name: 'unit', conclusion: 'failure', url: 'https://github.com/o/r/runs/1' },
      { name: 'e2e', conclusion: 'timed_out', url: null },
    ])
  })

  it('is empty when nothing has conclusively failed', () => {
    expect(listFailingChecks([check('completed', 'success'), check('in_progress', null)])).toEqual(
      [],
    )
  })

  it('excludes stale (superseded) checks — nothing for the ci-fixer to fix', () => {
    expect(listFailingChecks([check('completed', 'stale')])).toEqual([])
  })
})

// --- Multi-repo CI aggregation ----------------------------------------------------------

const repo = (name: string, checks: CiCheck[], headSha: string | null = 'sha1'): RepoCiStatus => ({
  repo: name,
  headSha,
  checks,
})

describe('aggregateRepoCi', () => {
  it('reduces every repo’s checks to ONE verdict, with a red check anywhere dominating', () => {
    const green = repo('acme/api', [check('completed', 'success')])
    const red = repo('acme/web', [check('completed', 'failure')])
    const running = repo('acme/jobs', [check('in_progress', null)])
    expect(aggregateRepoCi([green, green])).toBe('success')
    expect(aggregateRepoCi([green, running])).toBe('pending')
    expect(aggregateRepoCi([green, red])).toBe('failure')
    // A failure in ANY repo beats a pending elsewhere: the gate must not sleep on a red peer.
    expect(aggregateRepoCi([running, red])).toBe('failure')
  })

  it('is `none` for no repos and for repos that registered no checks', () => {
    expect(aggregateRepoCi([])).toBe('none')
    expect(aggregateRepoCi([repo('acme/api', []), repo('acme/web', [])])).toBe('none')
  })
})

describe('headFields', () => {
  it('reports the OWN-SERVICE head (the first entry) as the scalar', () => {
    expect(headFields([{ repo: 'acme/api', headSha: 'aaa' }])).toEqual({ headSha: 'aaa' })
  })

  it('omits the per-repo map on a single-repo block, so callers fall back to the scalar', () => {
    expect(headFields([])).toEqual({ headSha: null })
    expect(headFields([{ repo: 'acme/api', headSha: null }])).toEqual({ headSha: null })
    expect(headFields([{ repo: 'acme/api', headSha: 'aaa' }])).not.toHaveProperty('headShas')
  })

  it('adds the per-repo map on a MULTI-repo block, keyed by repo full name', () => {
    expect(
      headFields([
        { repo: 'acme/api', headSha: 'aaa' },
        { repo: 'acme/web', headSha: 'bbb' },
      ]),
    ).toEqual({ headSha: 'aaa', headShas: { 'acme/api': 'aaa', 'acme/web': 'bbb' } })
  })

  it('leaves a repo with no resolvable head OUT of the map rather than mapping it to null', () => {
    expect(
      headFields([
        { repo: 'acme/api', headSha: 'aaa' },
        { repo: 'acme/web', headSha: null },
      ]),
    ).toEqual({ headSha: 'aaa', headShas: { 'acme/api': 'aaa' } })
  })
})

describe('listFailingChecksAcrossRepos', () => {
  it('tags every failing check with the repo it came from, so the UI can group them', () => {
    expect(
      listFailingChecksAcrossRepos([
        repo('acme/api', [check('completed', 'failure', 'unit'), check('completed', 'success')]),
        repo('acme/web', [check('completed', 'timed_out', 'e2e', 'https://ci/e2e')]),
      ]),
    ).toEqual([
      { name: 'unit', conclusion: 'failure', url: null, repo: 'acme/api' },
      { name: 'e2e', conclusion: 'timed_out', url: 'https://ci/e2e', repo: 'acme/web' },
    ])
  })

  it('is empty when every repo is green or still running', () => {
    expect(
      listFailingChecksAcrossRepos([
        repo('acme/api', [check('completed', 'stale')]),
        repo('acme/web', [check('in_progress', null)]),
        repo('acme/jobs', []),
      ]),
    ).toEqual([])
  })
})

describe('describeFailingRepos', () => {
  it('reads exactly like the single-repo summary on a single-repo block', () => {
    const checks = [check('completed', 'failure', 'unit')]
    expect(describeFailingRepos([repo('acme/api', checks)])).toBe(describeFailingChecks(checks))
  })

  it('names WHICH service is red once more than one repo is in play', () => {
    const text = describeFailingRepos([
      repo('acme/api', [check('completed', 'failure', 'unit')]),
      repo('acme/web', [check('completed', 'success')]),
    ])
    expect(text).toBe('acme/api: unit (failure)')
  })

  it('separates the repos and joins each repo’s own checks', () => {
    expect(
      describeFailingRepos([
        repo('acme/api', [
          check('completed', 'failure', 'unit'),
          check('completed', 'cancelled', 'lint'),
        ]),
        repo('acme/web', [check('completed', 'timed_out', 'e2e')]),
      ]),
    ).toBe('acme/api: unit (failure), lint (cancelled); acme/web: e2e (timed_out)')
  })

  it('reports a null conclusion as a plain failure rather than as "null"', () => {
    // A completed check with no conclusion is not in the non-failing set, so it fails the gate;
    // rendering it as `null` to the human reads as a bug in the platform, not in their CI.
    const text = describeFailingRepos([
      repo('acme/api', [check('completed', null, 'unit')]),
      repo('acme/web', [check('completed', 'failure', 'e2e')]),
    ])
    expect(text).toBe('acme/api: unit (failure); acme/web: e2e (failure)')
  })

  it('falls back to the generic message when nothing is conclusively failing', () => {
    expect(describeFailingRepos([])).toBe('CI reported a failure.')
    expect(describeFailingRepos([repo('acme/api', [check('in_progress', null)])])).toBe(
      'CI reported a failure.',
    )
  })
})

const sig = (state: ReleaseSignal['state'], over: Partial<ReleaseSignal> = {}): ReleaseSignal => ({
  kind: 'monitor',
  id: 'm1',
  name: 'errors',
  state,
  ...over,
})

const report = (
  status: ReleaseHealthReport['status'],
  signals: ReleaseSignal[],
): ReleaseHealthReport => ({
  status,
  signals,
})

describe('classifyReleaseHealth', () => {
  it('escalates on a regression regardless of the window', () => {
    expect(
      classifyReleaseHealth({ report: report('regressed', [sig('alert')]), windowElapsed: false }),
    ).toBe('fail')
    expect(
      classifyReleaseHealth({ report: report('regressed', [sig('alert')]), windowElapsed: true }),
    ).toBe('fail')
  })

  it('keeps polling while the window is still open and nothing has regressed', () => {
    expect(
      classifyReleaseHealth({ report: report('pending', [sig('no_data')]), windowElapsed: false }),
    ).toBe('pending')
    expect(
      classifyReleaseHealth({ report: report('healthy', [sig('ok')]), windowElapsed: false }),
    ).toBe('pending')
  })

  it('passes once the window elapses with no regression — including a quiet/no_data signal', () => {
    // A healthy window passes…
    expect(
      classifyReleaseHealth({ report: report('healthy', [sig('ok')]), windowElapsed: true }),
    ).toBe('pass')
    // …and so does a still-`pending`/`no_data` one: the window is the grace period, and a
    // permanently-`no_data` monitor must NOT hang the gate until it fails as a timeout.
    expect(
      classifyReleaseHealth({ report: report('pending', [sig('no_data')]), windowElapsed: true }),
    ).toBe('pass')
  })
})

describe('describeRegressedSignals', () => {
  it('names the alerting signals with their detail', () => {
    const text = describeRegressedSignals([
      sig('alert', { name: 'p99 latency', detail: 'SLI 0.91 vs target 0.99' }),
      sig('ok', { name: 'apdex' }),
    ])
    expect(text).toContain('p99 latency')
    expect(text).toContain('SLI 0.91 vs target 0.99')
    expect(text).not.toContain('apdex')
  })

  it('falls back to a generic message when nothing is alerting', () => {
    expect(describeRegressedSignals([sig('warn')])).toBe('A monitored release signal regressed.')
  })
})

describe('renderReleaseEvidence', () => {
  const evidence = (over: Partial<ReleaseEvidence> = {}): ReleaseEvidence => ({
    regressedSignals: [],
    errors: [],
    ...over,
  })

  it('always states the task, so an empty bundle is still an investigable prompt', () => {
    const text = renderReleaseEvidence(evidence())
    expect(text.startsWith('## Post-release regression evidence')).toBe(true)
    expect(text).toContain('Investigate whether THIS PR is the likely cause')
    expect(text).toContain('"culpritConfidence"')
    // The on-call agent INVESTIGATES; reverting is a human's call.
    expect(text).toContain('Do NOT make commits or revert anything')
    // An absent section is omitted rather than rendered as an empty heading.
    expect(text).not.toContain('Regressed signals:')
    expect(text).not.toContain('Recent errors:')
  })

  it('renders each regressed signal with its kind, name, id and state', () => {
    const text = renderReleaseEvidence(
      evidence({
        regressedSignals: [
          sig('alert', { kind: 'monitor', id: 'm-7', name: '5xx rate', detail: '3.1% vs 0.5%' }),
          sig('alert', { kind: 'slo', id: 's-2', name: 'checkout SLO' }),
        ],
      }),
    )
    expect(text).toContain('Regressed signals:')
    expect(text).toContain('- monitor "5xx rate" (m-7): alert — 3.1% vs 0.5%')
    // A signal with no detail renders without a dangling separator.
    expect(text).toContain('- slo "checkout SLO" (s-2): alert')
    expect(text).not.toContain('(s-2): alert —')
  })

  it('renders each error with the counts and samples it actually has', () => {
    const text = renderReleaseEvidence(
      evidence({
        errors: [
          { title: 'TypeError', count: 42, sampleMessage: 'x is not a function' },
          { title: 'Timeout' },
          { title: 'Zero seen', count: 0 },
        ],
      }),
    )
    expect(text).toContain('Recent errors:')
    expect(text).toContain('- TypeError ×42 — x is not a function')
    expect(text).toContain('- Timeout')
    expect(text).not.toContain('- Timeout ×')
    // A genuine zero is a fact the count must state, not an absence to omit.
    expect(text).toContain('- Zero seen ×0')
  })

  it('includes the notes only when there are any', () => {
    expect(renderReleaseEvidence(evidence({ notes: 'Queried 30m post-deploy.' }))).toContain(
      'Queried 30m post-deploy.',
    )
    expect(renderReleaseEvidence(evidence({ notes: '' }))).not.toContain('Queried')
  })

  it('is pure: the same evidence renders the same bytes', () => {
    const bundle = evidence({
      regressedSignals: [sig('alert')],
      errors: [{ title: 'TypeError', count: 1 }],
      notes: 'n',
    })
    expect(renderReleaseEvidence(bundle)).toBe(renderReleaseEvidence(bundle))
  })
})
