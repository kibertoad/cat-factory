import { describe, expect, it } from 'vitest'
import type { AgentRunContext, ExecutionInstance, Pipeline } from '@cat-factory/kernel'
import type { ReproductionReport } from '@cat-factory/contracts'
import type { ConformanceHarness } from '../harness.js'

// BUGFIX REPRODUCTION PROOF conformance (backend/docs/adr/0033-bugfix-reproduction-proof.md).
//
// A bugfix run's PR should carry machine-captured evidence that a reproducing check failed on the
// pre-fix code and passes on the final tree — and, when reproduction is genuinely infeasible, an
// explicit structural declaration rather than an empty section. Three halves have to behave
// identically on D1 and Postgres:
//
//  1. THREADING — the prior `repro-test` step's structured declaration is resolved onto the
//     `AgentRunContext` of the PR-opening coder dispatch (which is what the container executor
//     turns into the harness job body). The `FakeAgentExecutor` stands in for that executor, so
//     its `onContext` observer is where the suite sees what would have ridden the body.
//  2. RECORDING — the harness's verdict is folded onto `PipelineStep.reproduction` and survives
//     the run's persisted `detail` blob round-trip.
//  3. THE CONCEDE PATH — a run whose reproduction step declared the bug non-reproducible
//     dispatches NO proof (there is nothing to run) and instead records the declaration itself,
//     with the reason and the stated alternative verification.
//
// The unconfigured case is asserted too, because "no declaration ⇒ byte-for-byte current
// behaviour" is the feature's core compatibility promise: a facade that resolved an empty spec
// onto the context — or wired the resolution on one runtime only — fails here rather than
// shipping.
export function defineReproductionProofConformance(harness: ConformanceHarness): void {
  describe('bugfix reproduction proof', () => {
    /** A reproduction → fix pipeline: the declaring step, then the PR-opening coder. */
    const bugfixPipeline = async (
      app: ReturnType<ConformanceHarness['makeApp']>,
      wsId: string,
    ): Promise<Pipeline> =>
      (
        await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Reproduce & fix',
          purpose: 'build',
          agentKinds: ['repro-test', 'coder'],
        })
      ).body

    /**
     * The `repro-test` structured outcome a run declares (the seam the proof reads). The second
     * path is deliberately a traversal: these paths are applied onto a base worktree, so the
     * engine drops anything that isn't repo-relative and COUNTS it — asserted below, because a
     * facade that threaded the raw declaration would ship a job body that writes outside the
     * checkout.
     */
    const declaration = {
      outcome: 'reproduced',
      testPaths: ['src/auth/login.test.ts', '../../etc/passwd'],
      notes: 'Login rejects a valid token after refresh.',
      command: 'pnpm vitest run src/auth/login.test.ts',
      setupCommand: 'pnpm install --frozen-lockfile',
    }

    const startAndDrive = async (
      app: ReturnType<ConformanceHarness['makeApp']>,
      wsId: string,
    ): Promise<ExecutionInstance[]> => {
      const pipeline = await bugfixPipeline(app, wsId)
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.id,
      })
      expect(start.status).toBe(201)
      return app.drive(wsId)
    }

    it('threads the run’s reproduction declaration onto the PR-opening coder dispatch', async () => {
      const contexts: AgentRunContext[] = []
      const app = harness.makeApp({
        onContext: (c) => contexts.push(c),
        customResultByKind: { 'repro-test': declaration },
      })
      const { workspace } = await app.createWorkspace()
      await startAndDrive(app, workspace.id)

      // The CODER carries the spec — it is the dispatch that opens the PR the proof is published
      // on. This is the whole "containers have no DB access" contract: everything the harness
      // needs to run the two trees rides the job body.
      const coderContext = contexts.find((c) => c.agentKind === 'coder')
      expect(coderContext?.reproduction).toMatchObject({
        command: 'pnpm vitest run src/auth/login.test.ts',
        // The traversing path is gone, and the drop is RECORDED — a proof run against a tree
        // rebuilt from an incomplete reproduction has to be able to say so.
        testPaths: ['src/auth/login.test.ts'],
        omittedTestPaths: 1,
        setupCommand: 'pnpm install --frozen-lockfile',
      })
      expect(coderContext?.reproduction?.maxAttempts).toBeGreaterThan(0)

      // The DECLARING step must not carry it: the proof compares a pre-fix tree with a fixed one,
      // and at repro-test time there is no fix to compare against.
      const reproContext = contexts.find((c) => c.agentKind === 'repro-test')
      expect(reproContext?.reproduction).toBeUndefined()
    })

    it('records the harness’s reproduction proof on the step', async () => {
      const report: ReproductionReport = {
        status: 'reproduced',
        command: 'pnpm vitest run src/auth/login.test.ts',
        testPaths: ['src/auth/login.test.ts'],
        base: { exitCode: 1, passed: false, outputTail: 'expected 200, got 401', durationMs: 900 },
        final: { exitCode: 0, passed: true, outputTail: '1 passed', durationMs: 850 },
        attempts: 1,
        maxAttempts: 3,
        at: 1700,
      }
      const app = harness.makeApp({
        customResultByKind: { 'repro-test': declaration },
        reproductionReport: report,
      })
      const { workspace } = await app.createWorkspace()
      const execs = await startAndDrive(app, workspace.id)
      const exec = execs.find((e) => e.blockId === 'task_login')

      // Persisted on the step's `detail` blob, so it survives a reload and both runtimes must
      // round-trip it identically — INCLUDING both captured outputs, which are the evidence a
      // reviewer actually reads. A facade that dropped the nested phases would pass a
      // status-only assertion.
      const coderStep = exec?.steps.find((s) => s.agentKind === 'coder')
      expect(coderStep?.reproduction?.status).toBe('reproduced')
      expect(coderStep?.reproduction?.base).toMatchObject({
        exitCode: 1,
        passed: false,
        outputTail: 'expected 200, got 401',
      })
      expect(coderStep?.reproduction?.final).toMatchObject({ exitCode: 0, passed: true })
    })

    it('records a CONCEDE as a structural declaration and dispatches no proof', async () => {
      const contexts: AgentRunContext[] = []
      const app = harness.makeApp({
        onContext: (c) => contexts.push(c),
        customResultByKind: {
          'repro-test': {
            outcome: 'not_reproducible',
            testPaths: [],
            notes: 'Needs production traffic volume; not reproducible in a test harness.',
            alternativeVerification:
              'Traced the refresh path against the reported request ids and reviewed the token clock-skew handling.',
          },
        },
      })
      const { workspace } = await app.createWorkspace()
      const execs = await startAndDrive(app, workspace.id)

      // Nothing to run, so nothing is dispatched — fabricating a command would produce a verdict
      // about a test that does not exist.
      const coderContext = contexts.find((c) => c.agentKind === 'coder')
      expect(coderContext?.reproduction).toBeUndefined()

      // But the run must NOT look like one that simply never tried: the engine folds the
      // declaration in itself, with the reason AND what was verified instead. This is the
      // difference the whole feature exists to make.
      const exec = execs.find((e) => e.blockId === 'task_login')
      const coderStep = exec?.steps.find((s) => s.agentKind === 'coder')
      expect(coderStep?.reproduction?.status).toBe('declared_infeasible')
      expect(coderStep?.reproduction?.reason).toContain('production traffic')
      expect(coderStep?.reproduction?.alternativeVerification).toContain('clock-skew')
    })

    it('carries NO reproduction when the run declares none (unchanged behaviour)', async () => {
      const contexts: AgentRunContext[] = []
      const app = harness.makeApp({ onContext: (c) => contexts.push(c) })
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // A plain coder pipeline — no reproduction step, so no declaration exists.
      const pipeline = (
        await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Build only',
          purpose: 'build',
          agentKinds: ['coder'],
        })
      ).body
      await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.id,
      })
      const execs: ExecutionInstance[] = await app.drive(wsId)

      // Absent — not an empty object — so the job body carries no `reproduction` field at all and
      // the harness runs the code path it ran before this feature existed.
      const coderContext = contexts.find((c) => c.agentKind === 'coder')
      expect(coderContext?.reproduction).toBeUndefined()

      // And the run itself is unaffected: it completes, and the step records no proof (an absent
      // report, never a fabricated "inconclusive" one — a run with nothing to prove has nothing
      // to say).
      const exec = execs.find((e) => e.blockId === 'task_login')
      expect(exec?.status).toBe('done')
      expect(exec?.steps[0]?.reproduction ?? null).toBeNull()
    })
  })
}
