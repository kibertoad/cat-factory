import { describe, expect, it } from 'vitest'
import type { AgentRunContext, ExecutionInstance, Pipeline } from '@cat-factory/kernel'
import type { ServiceValidationConfig, ValidationReport } from '@cat-factory/contracts'
import type { ConformanceHarness } from '../harness.js'

// PRE-PR VALIDATION conformance (docs/initiatives/pre-pr-validation.md).
//
// A service frame declares check commands; a PR-opening coding dispatch must carry them so the
// executor-harness can run them against the checkout BEFORE opening a pull request. Two halves
// have to behave identically on D1 and Postgres:
//
//  1. CONFIG RESOLUTION — the row is stored/read the same way, and a TASK's dispatch resolves the
//     commands by walking UP to its service frame (the config lives on the frame, never the task).
//  2. JOB-BODY THREADING — the resolved commands land on the `AgentRunContext` the container
//     executor turns into the harness job body. The `FakeAgentExecutor` stands in for that
//     executor, so its `onContext` observer is where the suite sees what would have ridden the
//     body. And the report the harness sends back is recorded on the step.
//
// The unconfigured case is asserted too, because "no config ⇒ byte-for-byte current behaviour" is
// the feature's core compatibility promise: a facade that resolved an empty config into the body
// (or wired the resolver only on one runtime) fails here rather than shipping.
export function defineValidationChecksConformance(harness: ConformanceHarness): void {
  describe('pre-PR validation checks', () => {
    /** Save a service frame's checks over the real HTTP route. */
    const saveChecks = async (
      app: ReturnType<ConformanceHarness['makeApp']>,
      wsId: string,
      blockId: string,
      body: { checks: { label: string; command: string }[]; maxAttempts?: number },
    ) =>
      app.call<ServiceValidationConfig>(
        'PUT',
        `/workspaces/${wsId}/services/${blockId}/validation-checks`,
        body,
      )

    /** A single-step coder pipeline — the PR-opening dispatch the feature gates. */
    const coderPipeline = async (app: ReturnType<ConformanceHarness['makeApp']>, wsId: string) =>
      (
        await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build only',
          agentKinds: ['coder'],
        })
      ).body

    it('stores, reads back and lists a service frame’s checks', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const saved = await saveChecks(app, wsId, 'blk_auth', {
        checks: [
          { label: 'lint', command: 'pnpm lint' },
          { label: 'test', command: 'pnpm test' },
        ],
        maxAttempts: 4,
      })
      expect(saved.status).toBe(200)
      expect(saved.body.checks).toEqual([
        { label: 'lint', command: 'pnpm lint' },
        { label: 'test', command: 'pnpm test' },
      ])
      expect(saved.body.maxAttempts).toBe(4)

      // Read back through the per-block route + the workspace listing (both hit the store).
      const read = await app.call<ServiceValidationConfig>(
        'GET',
        `/workspaces/${wsId}/services/blk_auth/validation-checks`,
      )
      expect(read.body.checks).toHaveLength(2)
      expect(read.body.maxAttempts).toBe(4)

      const list = await app.call<ServiceValidationConfig[]>(
        'GET',
        `/workspaces/${wsId}/validation-checks`,
      )
      expect(list.body.map((c) => c.blockId)).toContain('blk_auth')
    })

    it('defaults the attempt budget and clears the config on an empty list', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const saved = await saveChecks(app, wsId, 'blk_auth', {
        checks: [{ label: 'lint', command: 'pnpm lint' }],
      })
      expect(saved.body.maxAttempts).toBe(3)

      // An empty list DELETES the row — a cleared inspector must restore the exact pre-feature
      // behaviour, not leave an empty config that still has to be resolved on every dispatch.
      const cleared = await saveChecks(app, wsId, 'blk_auth', { checks: [] })
      expect(cleared.body.checks).toEqual([])
      const list = await app.call<ServiceValidationConfig[]>(
        'GET',
        `/workspaces/${wsId}/validation-checks`,
      )
      expect(list.body.map((c) => c.blockId)).not.toContain('blk_auth')
    })

    it('refuses checks on a non-frame block (they would never be resolved)', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createWorkspace()
      // `task_login` is a TASK inside `blk_auth`. Resolution only ever walks UP to the frame, so
      // a config stored here would silently never run — reject it at the write boundary instead.
      const res = await saveChecks(app, workspace.id, 'task_login', {
        checks: [{ label: 'lint', command: 'pnpm lint' }],
      })
      expect(res.status).toBe(422)
    })

    it('threads a task’s SERVICE-FRAME checks onto the dispatched agent context', async () => {
      const contexts: AgentRunContext[] = []
      const app = harness.makeApp({ onContext: (c) => contexts.push(c) })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // Configured on the FRAME; the run is on a TASK inside it — the frame-chain walk is the
      // thing under test (a facade that keyed resolution off the run block would see nothing).
      await saveChecks(app, wsId, 'blk_auth', {
        checks: [{ label: 'lint', command: 'pnpm lint' }],
        maxAttempts: 2,
      })

      const pipeline = await coderPipeline(app, wsId)
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.id,
      })
      expect(start.status).toBe(201)
      await app.drive(wsId)

      const coderContext = contexts.find((c) => c.agentKind === 'coder')
      expect(coderContext?.validationChecks).toEqual({
        checks: [{ label: 'lint', command: 'pnpm lint' }],
        maxAttempts: 2,
      })
    })

    it('carries NO checks when the service configured none (unchanged behaviour)', async () => {
      const contexts: AgentRunContext[] = []
      const app = harness.makeApp({ onContext: (c) => contexts.push(c) })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      const pipeline = await coderPipeline(app, wsId)
      await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.id,
      })
      const execs = await app.drive(wsId)

      const coderContext = contexts.find((c) => c.agentKind === 'coder')
      expect(coderContext).toBeDefined()
      // Absent — not an empty object — so the job body carries no `validationChecks` field at all
      // and the harness runs the code path it ran before this feature existed.
      expect(coderContext?.validationChecks).toBeUndefined()
      // And the run itself is unaffected.
      const exec = execs.find((e) => e.blockId === 'task_login')
      expect(exec?.status).toBe('done')
      expect(exec?.steps[0]?.validation ?? null).toBeNull()
    })

    it('records the harness’s validation report on the step', async () => {
      const report: ValidationReport = {
        passed: true,
        attempts: 2,
        maxAttempts: 3,
        at: 1700,
        outcomes: [
          {
            label: 'lint',
            command: 'pnpm lint',
            exitCode: 0,
            passed: true,
            outputTail: 'all clean',
            durationMs: 120,
          },
        ],
      }
      const app = harness.makeApp({ validationReport: report })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      await saveChecks(app, wsId, 'blk_auth', { checks: [{ label: 'lint', command: 'pnpm lint' }] })

      const pipeline = await coderPipeline(app, wsId)
      await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.id,
      })
      const execs: ExecutionInstance[] = await app.drive(wsId)
      const exec = execs.find((e) => e.blockId === 'task_login')

      // The captured proof the checkout was green before the PR opened — persisted on the step's
      // `detail` blob, so it survives a reload and both runtimes must round-trip it identically.
      expect(exec?.steps[0]?.validation?.passed).toBe(true)
      expect(exec?.steps[0]?.validation?.attempts).toBe(2)
      expect(exec?.steps[0]?.validation?.outcomes[0]).toMatchObject({
        label: 'lint',
        exitCode: 0,
        outputTail: 'all clean',
      })
    })
  })
}
