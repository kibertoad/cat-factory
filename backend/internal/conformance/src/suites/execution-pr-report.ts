import { PR_REPORT_MARKER_START, type Pipeline, type PullRequestRef } from '@cat-factory/kernel'
import { parsePrVerificationReport } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { FakePrReportPublisher } from '../FakePrReportPublisher.js'
import { makeFakeCi } from '../fakeGateProviders.js'
import type { ConformanceHarness } from '../harness.js'

// Execution-engine conformance: the engine-maintained PR VERIFICATION REPORT.
//
// The report is composed from the run's own state and published onto its PR as a
// marker-delimited section (see `docs/initiatives/pr-verification-report.md`). It is a
// runtime-neutral engine behaviour riding a wired port, which is exactly the class of thing
// that silently works on one facade and not the other — so composition, absent-section
// naming, JSON validity, in-place idempotency AND the unwired pass-through are all asserted
// against real D1 and real Postgres alike.
const PR: PullRequestRef = { number: 42, url: 'https://github.test/o/r/pull/42', branch: 'work' }
const APP_BASE_URL = 'https://app.example.test'
/** The BACKEND's own public origin — deliberately a different host from the SPA's above. */
const API_BASE_URL = 'https://api.example.test'

export function defineExecutionPrReportConformance(harness: ConformanceHarness): void {
  describe('execution engine', () => {
    describe('PR verification report', () => {
      it('composes CI + run metadata onto the PR and names the absent sections', async () => {
        const publisher = new FakePrReportPublisher()
        const app = harness.makeApp(
          { asyncKinds: ['coder'], pullRequest: PR },
          {
            prVerificationReportPublisher: publisher,
            appBaseUrl: APP_BASE_URL,
            gateProviders: { ciStatus: makeFakeCi([true]) },
          },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        // Deliberately NO tester and NO deployer step: the report must SAY those sections are
        // absent rather than omit them (a missing section reads exactly like a clean one).
        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + CI',
          agentKinds: ['coder', 'ci'],
        })
        const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect(start.status).toBe(201)

        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')

        const section = publisher.section('task_login')
        expect(section, 'expected a verification report on the PR').toBeTruthy()
        expect(section).toContain('Verification report')

        // The JSON block parses against the contracts schema — the machine-readable contract
        // external tooling ingests.
        const report = parsePrVerificationReport(publisher.reportJson('task_login'))

        // Run metadata.
        expect(report.run.executionId).toBe(exec.id)
        expect(report.run.blockId).toBe('task_login')
        expect(report.run.pipelineId).toBe(pipeline.body.id)
        expect(report.run.steps.map((s) => s.agentKind)).toEqual(['coder', 'ci'])
        expect(report.run.steps.every((s) => s.state === 'done')).toBe(true)

        // CI verdict, with the gate's own recorded detail.
        expect(report.ci.status).toBe('reported')
        expect(report.ci.verdict).toBe('pass')
        expect(report.ci.fixerAttempts).toBe(0)

        // Absent sections are NAMED, not omitted.
        expect(report.tests.status).toBe('absent')
        expect(report.tests.note).toContain('No tester step')
        expect(report.environments.status).toBe('absent')
        expect(report.environments.note).toContain('No deployer step')
        expect(report.merge.status).toBe('absent')
        expect(section).toContain('No tester step in this pipeline')
        expect(section).toContain('No deployer step in this pipeline')

        // The observability deep link is built from the deployment's public URL config —
        // never a hardcoded host — and carries the run's identity.
        expect(report.observability.runUrl).toBe(
          `${APP_BASE_URL}/?ws=${wsId}&block=task_login&run=${exec.id}&view=observability`,
        )
      })

      it('records a red CI verdict with its failing checks and fixer attempts', async () => {
        const publisher = new FakePrReportPublisher()
        // Red on the first probe, green after the ci-fixer round — so the settled report
        // carries a pass, but the attempt count proves a fixer ran.
        const app = harness.makeApp(
          { asyncKinds: ['coder', 'ci-fixer'], pullRequest: PR },
          {
            prVerificationReportPublisher: publisher,
            gateProviders: { ciStatus: makeFakeCi([false, true]) },
          },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + CI',
          agentKinds: ['coder', 'ci'],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')

        const report = parsePrVerificationReport(publisher.reportJson('task_login'))
        expect(report.ci.status).toBe('reported')
        expect(report.ci.fixerAttempts).toBe(1)
        // With no public app URL configured the report carries no link rather than a dead one.
        expect(report.observability.runUrl).toBeNull()
      })

      it('updates the report in place on a retry instead of appending a second copy', async () => {
        const publisher = new FakePrReportPublisher()
        // The coder's own PR description, written before the engine ever touched the body.
        publisher.seedBody('task_login', 'Implements the login task.\n')
        const app = harness.makeApp(
          { asyncKinds: ['coder'], pullRequest: PR },
          {
            prVerificationReportPublisher: publisher,
            gateProviders: { ciStatus: makeFakeCi([true]) },
          },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + CI',
          agentKinds: ['coder', 'ci'],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        const first = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(first.status).toBe('done')

        // Re-run the task: a fresh run publishes over the SAME PR body.
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        const second = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(second.status).toBe('done')

        const body = publisher.body('task_login')!
        // Exactly ONE managed region, and the agent's own prose above it is untouched.
        expect(body.split(PR_REPORT_MARKER_START).length - 1).toBe(1)
        expect(body.startsWith('Implements the login task.')).toBe(true)
        // …and it describes the LATEST run, not the first.
        const report = parsePrVerificationReport(publisher.reportJson('task_login'))
        expect(report.run.executionId).toBe(second.id)
      })

      registerCapturedEvidenceTests(harness)

      it('publishes nothing when the workspace turned the report off', async () => {
        // The per-workspace opt-out (`publishPrVerificationReport`). A pull request is a more
        // exposed surface than the telemetry store, so a workspace can decline it — and the
        // setting has to be read through each facade's OWN settings repository, which is
        // exactly the kind of wiring that silently works on one runtime and not the other.
        const publisher = new FakePrReportPublisher()
        const app = harness.makeApp(
          { asyncKinds: ['coder'], pullRequest: PR },
          {
            prVerificationReportPublisher: publisher,
            gateProviders: { ciStatus: makeFakeCi([true]) },
          },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const off = await app.call('PUT', `/workspaces/${wsId}/settings`, {
          publishPrVerificationReport: false,
        })
        expect(off.status).toBe(200)

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + CI',
          agentKinds: ['coder', 'ci'],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        expect(publisher.section('task_login')).toBeNull()
        expect(publisher.calls).toHaveLength(0)
      })

      it('publishes nothing when no report publisher is wired', async () => {
        // The pass-through that keeps every existing engine test — and every no-VCS
        // deployment — behaving exactly as it did before the feature.
        const app = harness.makeApp(
          { asyncKinds: ['coder'], pullRequest: PR },
          { gateProviders: { ciStatus: makeFakeCi([true]) } },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + CI',
          agentKinds: ['coder', 'ci'],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
      })

      it('publishes a SCOPED report onto a multi-repo run’s peer PR too', async () => {
        // Slice 11: a cross-service run opens one PR per repo it changed, and a reviewer on the
        // connected service's PR is as entitled to the run's evidence as one on the own-service
        // PR. Both get a report, and they are NOT the same document — the own-service-only
        // sections are withheld from the peer's copy rather than copied onto it, since that
        // repo's checks were never the ones that ran.
        const publisher = new FakePrReportPublisher()
        publisher.addPeer('task_login', 'acme/email', 12, 'frm_email')
        const app = harness.makeApp(
          {
            asyncKinds: ['coder'],
            pullRequest: PR,
            validationReport: {
              passed: true,
              attempts: 1,
              at: 1_700_000_000_000,
              outcomes: [
                {
                  label: 'lint',
                  command: 'pnpm lint',
                  exitCode: 0,
                  passed: true,
                  outputTail: 'ok',
                },
              ],
            },
          },
          {
            prVerificationReportPublisher: publisher,
            gateProviders: { ciStatus: makeFakeCi([true]) },
          },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build + CI',
          agentKinds: ['coder', 'ci'],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        expect((await app.drive(wsId)).find((e) => e.blockId === 'task_login')?.status).toBe('done')

        // BOTH pull requests carry a report, each in its own body.
        const own = parsePrVerificationReport(publisher.reportJson('task_login'))
        const peer = parsePrVerificationReport(publisher.peerReportJson('task_login', 'acme/email'))

        expect(own.scope?.role).toBe('own')
        expect(peer.scope?.role).toBe('peer')
        expect(peer.scope?.frameId).toBe('frm_email')
        // The peer's copy points back at the own-service PR — without it the withholding note
        // below would be a dead end.
        expect(peer.scope?.ownPullRequest).toMatchObject({ repo: 'acme/api', number: 1 })
        expect(own.scope?.ownPullRequest ?? null).toBeNull()

        // Each report names the repo whose PR it is written onto.
        expect(own.run.repo).toBe('acme/api')
        expect(peer.run.repo).toBe('acme/email')

        // RUN-scoped evidence is reported identically on both: the CI gate reduces every repo's
        // checks to one verdict that blocks the whole set, so a peer reviewer must see it.
        expect(own.ci.verdict).toBe('pass')
        expect(peer.ci.verdict).toBe('pass')

        // OWN-SERVICE-only evidence is withheld from the peer, and says so rather than going
        // silently missing (which would read exactly like a clean section).
        expect(own.validation.status).toBe('reported')
        expect(peer.validation.status).toBe('absent')
        expect(peer.validation.note).toContain('Not computed for this repository')
        expect(peer.validation.note).toContain('acme/api#1')
        expect(peer.validation.commands).toEqual([])
        expect(peer.reproduction.status).toBe('absent')
        expect(peer.requirements.status).toBe('absent')

        // The prose says it too, not only the machine-readable block.
        const peerSection = publisher.peerSection('task_login', 'acme/email')!
        expect(peerSection).toContain("connected service's pull request")
        // The own-service report is unchanged by any of this: no banner, no withholding.
        expect(publisher.section('task_login')).not.toContain("connected service's pull request")
      })
    })
  })
}

/**
 * The two CAPTURED-OUTPUT sections plus the artifact links: the report's evidence that a COMMAND
 * ran and what it printed, as opposed to a verdict somebody produced.
 *
 * Registered from the suite above; split out purely to keep each function within the per-function
 * line budget. Every test is unchanged.
 */
function registerCapturedEvidenceTests(harness: ConformanceHarness): void {
  it('carries the pre-PR validation commands and the FAILING one’s captured output', async () => {
    // Slice 9 of the report: the platform's OWN run of the service's check commands against
    // the tree that opened the PR — the one verdict here the platform ENFORCED, as opposed to
    // the host's later opinion in the `ci` section. Runtime-neutral engine behaviour reading a
    // harness-written step field, so it is asserted on D1 and Postgres alike.
    const publisher = new FakePrReportPublisher()
    const app = harness.makeApp(
      {
        asyncKinds: ['coder'],
        pullRequest: PR,
        validationReport: {
          passed: false,
          attempts: 2,
          maxAttempts: 3,
          at: 1_700_000_000_000,
          outcomes: [
            { label: 'lint', command: 'pnpm lint', exitCode: 0, passed: true, outputTail: 'ok' },
            {
              label: 'test',
              command: 'pnpm test',
              exitCode: 1,
              passed: false,
              outputTail: 'AssertionError: expected 200, got 401',
            },
          ],
        },
      },
      { prVerificationReportPublisher: publisher, gateProviders: { ciStatus: makeFakeCi([true]) } },
    )
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + CI',
      agentKinds: ['coder', 'ci'],
    })
    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: pipeline.body.id,
    })
    expect((await app.drive(wsId)).find((e) => e.blockId === 'task_login')?.status).toBe('done')

    const report = parsePrVerificationReport(publisher.reportJson('task_login'))
    expect(report.validation.status).toBe('reported')
    expect(report.validation.passed).toBe(false)
    expect(report.validation.attempts).toBe(2)
    expect(report.validation.commands.map((c) => c.label)).toEqual(['lint', 'test'])
    // The failing command's log is the evidence; the passing one's is deliberately dropped so
    // the failing one stays inside the body budget, and the section says which rule it applied.
    expect(report.validation.commands[0]?.outputTail ?? null).toBeNull()
    expect(report.validation.commands[1]?.outputTail).toContain('expected 200, got 401')

    const section = publisher.section('task_login')!
    expect(section).toContain('Pre-PR validation')
    expect(section).toContain('AssertionError: expected 200, got 401')
    expect(section).toContain('retained for FAILING commands only')
  })

  it('carries the bugfix reproduction proof, with both trees’ captured output', async () => {
    // Phase C of the reproduction-proof initiative: red on the pre-fix tree, green on the
    // final one is the ONLY shape that proves "this change fixes the bug", and the verdict is
    // the harness's (computed from two exit codes) rather than the model's own claim.
    const publisher = new FakePrReportPublisher()
    const app = harness.makeApp(
      {
        asyncKinds: ['coder'],
        pullRequest: PR,
        customResultByKind: {
          'repro-test': {
            outcome: 'reproduced',
            testPaths: ['src/auth/login.test.ts'],
            notes: 'Login rejects a valid token after refresh.',
            command: 'pnpm vitest run src/auth/login.test.ts',
          },
        },
        reproductionReport: {
          status: 'reproduced',
          command: 'pnpm vitest run src/auth/login.test.ts',
          testPaths: ['src/auth/login.test.ts'],
          base: { exitCode: 1, passed: false, outputTail: 'expected 200, got 401' },
          final: { exitCode: 0, passed: true, outputTail: '1 passed' },
          attempts: 1,
          maxAttempts: 3,
          at: 1_700_000_000_000,
        },
      },
      { prVerificationReportPublisher: publisher },
    )
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Reproduce & fix',
      agentKinds: ['repro-test', 'coder'],
    })
    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: pipeline.body.id,
    })
    expect((await app.drive(wsId)).find((e) => e.blockId === 'task_login')?.status).toBe('done')

    const report = parsePrVerificationReport(publisher.reportJson('task_login'))
    expect(report.reproduction.status).toBe('reported')
    expect(report.reproduction.verdict).toBe('reproduced')
    expect(report.reproduction.command).toContain('login.test.ts')
    // BOTH logs ride the report: only a human reading them can see whether the pre-fix tree
    // was red for the RIGHT reason, which the symmetric-worktree design does not claim to know.
    expect(report.reproduction.base?.outputTail).toContain('got 401')
    expect(report.reproduction.final?.outputTail).toContain('1 passed')

    const section = publisher.section('task_login')!
    expect(section).toContain('Reproduction proof')
    expect(section).toContain('FAILED on the pre-fix tree')
  })

  it('states a CONCEDED reproduction rather than leaving the section blank', async () => {
    // The distinction the whole feature exists to make: "could not be reproduced" must never
    // be indistinguishable from "nobody tried". A concede dispatches no proof at all, so the
    // ENGINE mints the declaration — which is exactly the kind of engine-side fold that can
    // work on one facade and not the other.
    const publisher = new FakePrReportPublisher()
    const app = harness.makeApp(
      {
        asyncKinds: ['coder'],
        pullRequest: PR,
        customResultByKind: {
          'repro-test': {
            outcome: 'not_reproducible',
            testPaths: [],
            notes: 'Needs production traffic volume.',
            alternativeVerification: 'Traced the refresh path against the reported request ids.',
          },
        },
      },
      { prVerificationReportPublisher: publisher },
    )
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Reproduce & fix',
      agentKinds: ['repro-test', 'coder'],
    })
    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: pipeline.body.id,
    })
    expect((await app.drive(wsId)).find((e) => e.blockId === 'task_login')?.status).toBe('done')

    const report = parsePrVerificationReport(publisher.reportJson('task_login'))
    expect(report.reproduction.verdict).toBe('declared_infeasible')
    expect(report.reproduction.reason).toContain('production traffic')
    expect(report.reproduction.alternativeVerification).toContain('refresh path')

    const section = publisher.section('task_login')!
    expect(section).toContain('declared infeasible')
    expect(section).toContain('Verified instead')
  })

  it('links each captured artifact to its bytes, not just its id', async () => {
    // The evidence rows used to carry an opaque store id and nothing else, so reaching a
    // screenshot meant knowing the app well enough to find the run. The link is built from the
    // deployment's own BACKEND url (not the SPA origin beside it, which is a different host the
    // moment the SPA is served separately), so both facades have to thread the right config.
    const publisher = new FakePrReportPublisher()
    const app = harness.makeApp(
      {
        asyncKinds: ['coder', 'tester-api'],
        asyncPolls: 1,
        pullRequest: PR,
        testReports: [
          {
            greenlight: true,
            summary: 'looks right',
            tested: ['login'],
            outcomes: [{ name: 'login', status: 'passed' as const }],
            concerns: [],
            environment: 'ephemeral' as const,
            screenshots: [{ view: 'login', artifactId: 'art_1' }],
          },
        ],
      },
      {
        prVerificationReportPublisher: publisher,
        appBaseUrl: APP_BASE_URL,
        apiBaseUrl: API_BASE_URL,
      },
    )
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id

    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build + test',
      agentKinds: ['coder', 'deployer', 'tester-api', 'disposer'],
    })
    await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
      pipelineId: pipeline.body.id,
    })
    expect((await app.drive(wsId)).find((e) => e.blockId === 'task_login')?.status).toBe('done')

    const report = parsePrVerificationReport(publisher.reportJson('task_login'))
    const shot = report.environments.evidence.screenshots[0]
    expect(shot?.artifactId).toBe('art_1')
    // The id STAYS beside the link: it is what an operator greps the store for, and a
    // deployment with no public backend URL has only that to offer.
    expect(shot?.url).toBe(`${API_BASE_URL}/workspaces/${wsId}/artifacts/art_1/blob`)
    expect(publisher.section('task_login')).toContain(
      `${API_BASE_URL}/workspaces/${wsId}/artifacts/art_1/blob`,
    )
  })
}
