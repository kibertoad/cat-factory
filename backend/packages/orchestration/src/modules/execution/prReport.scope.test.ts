import type { Block, ExecutionInstance, PipelineStep, PrReportScope } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { composePrVerificationReport, renderPrVerificationReport } from './prReport.logic.js'

// The report's PER-PULL-REQUEST scoping (slice 11 of the PR-verification-report initiative).
//
// A cross-service run opens one PR per repo it changed and every one of them gets a report. The
// reports are NOT interchangeable: most of what the run proved is run-scoped, but pre-PR
// validation, the reproduction proof and the requirement join are statements about the
// OWN-SERVICE repo. Copying those onto a peer's PR would attribute one repo's evidence to
// another repo's diff, so they are WITHHELD — loudly, with a pointer to where they live.

const BLOCK = { id: 'blk_1', title: 'Add login', level: 'task' } as unknown as Block

function step(partial: Partial<PipelineStep> & { agentKind: string }): PipelineStep {
  return { state: 'done', progress: 1, decision: null, ...partial } as unknown as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    pipelineId: 'pl_simple',
    pipelineName: 'Quick implement',
    steps,
    currentStep: steps.length - 1,
    status: 'done',
  } as ExecutionInstance
}

const BASE_INPUTS = {
  block: BLOCK,
  issues: [],
  runUrl: null,
  trajectoryUrl: null,
  reportUrl: null,
  environments: { provisioning: { status: 'unwired' as const }, evidenceUrl: null },
  now: 1_700_000_000_000,
}

/** A run that produced all three own-service-only sections' evidence. */
const STEPS = [
  step({
    agentKind: 'coder',
    validation: {
      passed: true,
      attempts: 1,
      at: 1_700_000_000_000,
      outcomes: [
        { label: 'lint', command: 'pnpm lint', exitCode: 0, passed: true, outputTail: 'ok' },
      ],
    },
    reproduction: {
      status: 'reproduced',
      command: 'pnpm vitest run login.test.ts',
      testPaths: ['login.test.ts'],
      base: { exitCode: 1, passed: false, outputTail: 'expected 200, got 401' },
      final: { exitCode: 0, passed: true, outputTail: '1 passed' },
      attempts: 1,
      at: 1_700_000_000_000,
    },
  } as unknown as Partial<PipelineStep> & { agentKind: string }),
  step({
    agentKind: 'ci',
    gate: {
      lastVerdict: 'fail',
      attempts: 1,
      maxAttempts: 3,
      headSha: 'aaa111',
      headShas: { 'acme/api': 'aaa111', 'acme/email': 'bbb222' },
      failingChecks: [{ name: 'unit', conclusion: 'failure', url: null, repo: 'acme/email' }],
    },
  } as unknown as Partial<PipelineStep> & { agentKind: string }),
]

const PEER_SCOPE: PrReportScope = {
  role: 'peer',
  frameId: 'frm_email',
  ownPullRequest: { repo: 'acme/api', number: 7, url: 'https://github.test/acme/api/pull/7' },
}

const composeFor = (scope: PrReportScope | undefined, repo: string) =>
  composePrVerificationReport(instance(STEPS), {
    ...BASE_INPUTS,
    repo,
    ...(scope ? { scope } : {}),
  })

describe('PR report scoping', () => {
  it('defaults to the own-service scope when none is supplied', () => {
    // Every single-repo run, and the shape the report had before peer reports existed.
    const report = composeFor(undefined, 'acme/api')
    expect(report.scope?.role).toBe('own')
    expect(report.scope?.ownPullRequest ?? null).toBeNull()
    expect(report.validation.status).toBe('reported')
  })

  it('withholds the own-service-only sections from a peer report, naming where they live', () => {
    const report = composeFor(PEER_SCOPE, 'acme/email')

    for (const section of [report.validation, report.reproduction, report.requirements]) {
      expect(section.status).toBe('absent')
      expect(section.note).toContain('Not computed for this repository')
      // The pointer: without it the withholding note is a dead end.
      expect(section.note).toContain('acme/api#7')
    }
    // Withheld means EMPTY, never a partial copy of the own-service numbers.
    expect(report.validation.commands).toEqual([])
    expect(report.reproduction.testPaths).toEqual([])
    expect(report.requirements.entries).toEqual([])
    expect(report.requirements.total).toBe(0)
  })

  it('says the own-service PR is not open yet rather than naming one that is not there', () => {
    // The coding agent can push a connected service's change first. Naming a pull request that
    // does not exist is worse than saying it does not.
    const report = composeFor({ role: 'peer', frameId: null, ownPullRequest: null }, 'acme/email')
    expect(report.validation.note).toContain('has not opened yet')
    expect(report.validation.note).not.toContain('#')
  })

  it('reports the RUN-scoped CI verdict unchanged on a peer PR', () => {
    // The gate reduces every repo's checks to one verdict that blocks the whole merge set, so a
    // peer reviewer must see that the run is stuck — including when the red repo is not theirs.
    const report = composeFor(PEER_SCOPE, 'acme/email')
    expect(report.ci.status).toBe('reported')
    expect(report.ci.verdict).toBe('fail')
    expect(report.ci.failingChecks.map((c) => c.repo)).toEqual(['acme/email'])
  })

  it('states each PR’s OWN head commit, not the own-service one', () => {
    // A peer repo has never heard of the own-service head sha.
    expect(composeFor(undefined, 'acme/api').ci.headSha).toBe('aaa111')
    expect(composeFor(PEER_SCOPE, 'acme/email').ci.headSha).toBe('bbb222')
  })

  it('falls back to the scalar head when the gate recorded no per-repo map', () => {
    const single = instance([
      step({
        agentKind: 'ci',
        gate: { lastVerdict: 'pass', attempts: 0, headSha: 'ccc333', failingChecks: [] },
      } as unknown as Partial<PipelineStep> & { agentKind: string }),
    ])
    const report = composePrVerificationReport(single, { ...BASE_INPUTS, repo: 'acme/api' })
    expect(report.ci.headSha).toBe('ccc333')
  })
})

describe('PR report scope rendering', () => {
  it('opens a peer report with a banner explaining what it is', () => {
    const section = renderPrVerificationReport(composeFor(PEER_SCOPE, 'acme/email'))
    expect(section).toContain("connected service's pull request")
    expect(section).toContain('https://github.test/acme/api/pull/7')
  })

  it('defuses the own-service PR reference in a withheld section’s note', () => {
    // `owner/repo#12` in a PR body is a cross-repo reference the host RESOLVES and back-links, so
    // a peer's report would file an event on the own-service PR for every publish. The note is a
    // statement ABOUT that pull request, not an event on it; the banner above carries the link.
    const section = renderPrVerificationReport(composeFor(PEER_SCOPE, 'acme/email'))
    // The PROSE half only: the machine-readable block below it keeps the note verbatim, which is
    // both correct (a consumer wants the text, not entities) and safe (the host does not
    // auto-link inside a fence).
    const prose = section.slice(0, section.indexOf('<details>'))
    expect(prose).toContain('acme/api&#35;7')
    expect(prose).not.toContain('acme/api#7')
  })

  it('renders NO banner on an own-service report', () => {
    // The ordinary single-repo case must be byte-for-byte what it was.
    const section = renderPrVerificationReport(composeFor(undefined, 'acme/api'))
    expect(section).not.toContain("connected service's pull request")
  })

  it('adds a repo column to the CI table only when the checks are repo-tagged', () => {
    // The gate tags checks with a repo exactly on a multi-repo run. Without the column a
    // cross-service reviewer cannot tell which repo is actually broken.
    expect(renderPrVerificationReport(composeFor(PEER_SCOPE, 'acme/email'))).toContain(
      '| Check | Repo | Conclusion |',
    )

    const single = instance([
      step({
        agentKind: 'ci',
        gate: {
          lastVerdict: 'fail',
          attempts: 0,
          headSha: 'ccc333',
          failingChecks: [{ name: 'unit', conclusion: 'failure', url: null }],
        },
      } as unknown as Partial<PipelineStep> & { agentKind: string }),
    ])
    const section = renderPrVerificationReport(
      composePrVerificationReport(single, { ...BASE_INPUTS, repo: 'acme/api' }),
    )
    expect(section).toContain('| Check | Conclusion |')
    expect(section).not.toContain('| Check | Repo | Conclusion |')
  })
})
