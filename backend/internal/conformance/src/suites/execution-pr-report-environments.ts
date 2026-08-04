import type { EnvironmentProvider, Pipeline, PullRequestRef } from '@cat-factory/kernel'
import { parsePrVerificationReport } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { FakePrReportPublisher } from '../FakePrReportPublisher.js'
import type { ConformanceHarness } from '../harness.js'

// Execution-engine conformance: the PR verification report's TEST ENVIRONMENT LIFECYCLE proof:
// environment UP → evidence CAPTURED from it while live → teardown CONFIRMED.
//
// It belongs in conformance rather than a unit test because the two facts it turns on are pure
// facade wiring, and each is the kind that silently works on one runtime and not the other:
//
//  1. The lifecycle DATES come from the provisioning event log, which lives in a physically
//     separate store per runtime (its own D1 binding on Cloudflare, its own Postgres schema on
//     Node). A facade that failed to wire that repository into the engine would report every
//     environment as un-evidenced, forever and silently.
//
//  2. The teardown leg is closed by an edge that fires AFTER the run settles (the teardown
//     itself), so it exercises the engine's out-of-band republish rather than the step hook
//     every other section rides. Nothing in a run-scoped test can catch that regressing.
const PR: PullRequestRef = { number: 42, url: 'https://github.test/o/r/pull/42', branch: 'work' }
const APP_BASE_URL = 'https://app.example.test'

/** A provider whose environments come up immediately and tear down on request. */
const readyProvider = {
  provision: async () => ({
    externalId: 'env-1',
    status: 'ready',
    url: 'https://preview.example',
    expiresAt: null,
    access: null,
    fields: {},
  }),
  status: async () =>
    ({ externalId: 'env-1', status: 'ready', url: 'https://preview.example' }) as never,
  teardown: async () => ({ status: 'torn_down' }) as never,
} as unknown as EnvironmentProvider

/** The same provider, except that reclaiming the environment is refused by the far end. */
const teardownRefusingProvider = {
  ...readyProvider,
  teardown: async () => {
    throw new Error('provider refused: environment is locked')
  },
} as unknown as EnvironmentProvider

/** The manifest connection a `deployer` needs to reach the injected provider at all. */
const MANIFEST = {
  providerId: 'acme-envs',
  label: 'Acme Ephemeral Envs',
  baseUrl: 'https://envs.test/api',
  auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
  provision: { method: 'POST', pathTemplate: '/environments' },
  response: { urlPath: 'url', statusPath: 'state', externalIdPath: 'id' },
}

export function defineExecutionPrReportEnvironmentsConformance(harness: ConformanceHarness): void {
  describe('execution engine', () => {
    describe('PR verification report: test environment lifecycle', () => {
      // The mothership harness runs no real deployer (it registers no environment connection of
      // its own), matching the other deployer-driving suites.
      it.skipIf(harness.name === 'mothership')(
        'dates the environment lifecycle and closes the proof when it is torn down',
        async () => {
          const publisher = new FakePrReportPublisher()
          const app = harness.makeApp(
            {
              asyncKinds: ['tester-api'],
              pullRequest: PR,
              testReports: [
                {
                  greenlight: true,
                  summary: 'exercised login against the preview',
                  tested: ['login'],
                  outcomes: [{ name: 'login', status: 'passed' as const }],
                  concerns: [],
                  environment: 'ephemeral' as const,
                },
              ],
            },
            {
              prVerificationReportPublisher: publisher,
              environmentProvider: readyProvider,
              appBaseUrl: APP_BASE_URL,
            },
          )
          const { workspace } = await app.createWorkspace()
          const wsId = workspace.id

          const registered = await app.call('POST', `/workspaces/${wsId}/environments/connection`, {
            config: { kind: 'manifest', manifest: MANIFEST },
            secrets: { API_TOKEN: 'super-secret-env-token' },
          })
          expect(registered.status).toBe(201)

          const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
            name: 'Deploy + test',
            agentKinds: ['deployer', 'tester-api'],
          })
          await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
            pipelineId: pipeline.body.id,
          })
          const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
          expect(exec.status).toBe('done')

          // While the run is settling the environment is still standing, so the proof is
          // deliberately INCOMPLETE and says which leg is open. A report that called this
          // complete would be exactly the overstatement the section exists to prevent.
          const live = parsePrVerificationReport(publisher.reportJson('task_login'))
          expect(live.environments.status).toBe('reported')
          expect(live.environments.entries.some((e) => e.status === 'ready')).toBe(true)
          // The provisioning log DATED the bring-up, through the facade-wired repository the engine
          // reads for this. An unwired one would report the whole timeline as un-evidenced.
          expect(live.environments.timeline.gap).toBeNull()
          expect(live.environments.timeline.provisionedAt).toBeGreaterThan(0)
          expect(live.environments.timeline.tornDownAt).toBeNull()
          expect(live.environments.teardown).toBe('pending')
          expect(live.environments.proof).toBe('incomplete')
          expect(live.environments.gaps.join(' ')).toContain('may still be running')

          // The tester declared it ran against the ephemeral environment, so its observations
          // ARE attributable to it, and the report links back to them.
          expect(live.environments.evidence.status).toBe('captured')
          expect(live.environments.evidence.ranAgainst).toBe('ephemeral')
          expect(live.environments.evidence.outcomes).toBe(1)
          expect(live.environments.evidence.url).toBe(
            `${APP_BASE_URL}/?ws=${wsId}&block=task_login&run=${exec.id}&view=test-evidence`,
          )

          // Now tear the environment down, the way the TTL sweep does: AFTER the run settled,
          // so no step hook is left to fire. The teardown itself re-publishes the report.
          const envs = await app.call<{ id: string }[]>('GET', `/workspaces/${wsId}/environments`)
          expect(envs.body).toHaveLength(1)
          const torn = await app.call(
            'POST',
            `/workspaces/${wsId}/environments/${envs.body[0]!.id}/teardown`,
            {},
          )
          expect(torn.status).toBe(200)

          const settled = parsePrVerificationReport(publisher.reportJson('task_login'))
          expect(settled.environments.timeline.tornDownAt).toBeGreaterThan(0)
          expect(settled.environments.teardown).toBe('confirmed')
          expect(settled.environments.proof).toBe('complete')
          expect(settled.environments.gaps).toEqual([])
          expect(publisher.section('task_login')).toContain(
            'environment up → evidence captured against it → teardown confirmed',
          )
        },
      )

      // The FAILURE edge of the same out-of-band republish. A settled run has no step hook left,
      // so an environment the provider refuses to reclaim reaches the PR only if the teardown
      // path notifies on a failed attempt too. Without it the section reads "nobody has torn this
      // down yet" about the one case that needs a human, which is the unreachable-leg hole this
      // whole section exists to close, one state over.
      it.skipIf(harness.name === 'mothership')(
        'puts an environment the provider REFUSED to reclaim on the PR as an operator action',
        async () => {
          const publisher = new FakePrReportPublisher()
          const app = harness.makeApp(
            { pullRequest: PR },
            {
              prVerificationReportPublisher: publisher,
              environmentProvider: teardownRefusingProvider,
              appBaseUrl: APP_BASE_URL,
            },
          )
          const { workspace } = await app.createWorkspace()
          const wsId = workspace.id

          const registered = await app.call('POST', `/workspaces/${wsId}/environments/connection`, {
            config: { kind: 'manifest', manifest: MANIFEST },
            secrets: { API_TOKEN: 'super-secret-env-token' },
          })
          expect(registered.status).toBe(201)

          const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
            name: 'Deploy only',
            agentKinds: ['deployer'],
          })
          await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
            pipelineId: pipeline.body.id,
          })
          const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
          expect(exec.status).toBe('done')

          const envs = await app.call<{ id: string }[]>('GET', `/workspaces/${wsId}/environments`)
          expect(envs.body).toHaveLength(1)
          const refused = await app.call(
            'POST',
            `/workspaces/${wsId}/environments/${envs.body[0]!.id}/teardown`,
            {},
          )
          // The provider error still surfaces to whoever asked: the report is bookkeeping beside
          // it, never in place of it.
          expect(refused.status).toBeGreaterThanOrEqual(400)

          const settled = parsePrVerificationReport(publisher.reportJson('task_login'))
          expect(settled.environments.teardown).toBe('failed')
          expect(settled.environments.timeline.teardownFailures).toBe(1)
          expect(settled.environments.gaps.join(' ')).toContain('needs reclaiming by hand')
        },
      )

      it('reports the lifecycle as un-evidenced rather than claiming nothing was torn down', async () => {
        // A pipeline with no deployer stands nothing up, so there is no proof to be incomplete
        // about, but the section still has to SAY so, and a tester that ran locally must not be
        // read as evidence about an environment that never existed.
        const publisher = new FakePrReportPublisher()
        const app = harness.makeApp(
          {
            asyncKinds: ['tester-api'],
            pullRequest: PR,
            testReports: [
              {
                greenlight: true,
                summary: 'ran the suite locally',
                tested: ['login'],
                outcomes: [{ name: 'login', status: 'passed' as const }],
                concerns: [],
                environment: 'local' as const,
              },
            ],
          },
          { prVerificationReportPublisher: publisher },
        )
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Test only',
          agentKinds: ['tester-api'],
        })
        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: pipeline.body.id,
        })
        const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')

        const report = parsePrVerificationReport(publisher.reportJson('task_login'))
        expect(report.environments.status).toBe('absent')
        expect(report.environments.note).toContain('No deployer step')
        expect(report.environments.proof).toBe('not_applicable')
        expect(report.environments.evidence.status).toBe('local')
        expect(report.environments.evidence.note).toContain('not evidence about the ephemeral')
      })
    })
  })
}
