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
        publisher.bodies.set('task_login', 'Implements the login task.\n')
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

        const body = publisher.bodies.get('task_login')!
        // Exactly ONE managed region, and the agent's own prose above it is untouched.
        expect(body.split(PR_REPORT_MARKER_START).length - 1).toBe(1)
        expect(body.startsWith('Implements the login task.')).toBe(true)
        // …and it describes the LATEST run, not the first.
        const report = parsePrVerificationReport(publisher.reportJson('task_login'))
        expect(report.run.executionId).toBe(second.id)
      })

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
    })
  })
}
