import type { ExecutionInstance, Pipeline } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// Execution-engine conformance: how a run that FAILED, or nearly did, is classified and recorded.
//
// Split out of `execution-review.ts` (which held it beside the companion-gate tests) when that file
// crossed its size budget. The seam is the one its own docblock already named: a companion gate is a
// verdict ON work, and these are about a job that never got to deliver work at all, which is also
// what decides their shape. Each one pins a DISTINCTION the SPA renders a different remedy for, so a
// facade that collapsed two of them would still pass a test that only asserted "the run failed".
export function defineExecutionFailureConformance(harness: ConformanceHarness): void {
  describe('execution engine', () => {
    registerAgentFailureTests(harness)
  })
}

/** Registered from the suite above; the tests are unchanged by the move. */
function registerAgentFailureTests(harness: ConformanceHarness): void {
  it('classifies a container-start (dispatch) failure as `dispatch`, not a generic run failure', async () => {
    // When the container/runner never accepts the job (startJob throws), the engine
    // must classify it as a `dispatch` failure ("Container failed to start") and carry
    // the verbatim provider error as the detail — identically on both runtimes — rather
    // than a generic "Run failed" with a misleading "inspect the container logs" hint.
    const app = harness.makeApp({
      asyncKinds: ['coder'],
      dispatchThrowKinds: ['coder'],
      dispatchThrowMessage: 'Container dispatch failed (HTTP 503): no capacity',
    })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build only',
      purpose: 'build',
      agentKinds: ['coder'],
    })
    const start = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: pipeline.body.id },
    )
    expect(start.status).toBe(201)
    const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect(exec.status).toBe('failed')
    expect(exec.failure?.kind).toBe('dispatch')
    // The verbatim provider/runtime response is preserved as the detail for triage.
    expect(exec.failure?.detail).toContain('HTTP 503')
    // The step did not falsely complete; the container is surfaced as errored (the
    // details say the container failed to start, not a generic "run failed").
    const coderStep = exec.steps.find((s) => s.agentKind === 'coder')!
    expect(coderStep.state).not.toBe('done')
    expect(coderStep.container?.status).toBe('errored')
    // The investigation diagnostics survive the failure they exist for. They used to be
    // stamped from the job handle, which only exists once a container has ACCEPTED the job,
    // so this failure, the one where "which step, which kind, which model" is hardest to
    // reconstruct afterwards, recorded nothing at all.
    const dispatch = exec.diagnostics?.lastDispatch
    expect(dispatch?.agentKind).toBe('coder')
    expect(dispatch?.stepIndex).toBe(0)
    expect(dispatch?.failure?.kind).toBe('dispatch')
    // No repo: nothing resolved one, and claiming a repo the dispatch never reached would be
    // worse than an absent field.
    expect(dispatch?.repo).toBeUndefined()
  })

  it('records diagnostics for an INLINE step, naming its backend', async () => {
    // An inline step dispatches nowhere, which is why it used to stamp nothing: a pure-inline
    // run reported no diagnostics at all, and a mixed pipeline reported whatever CONTAINER
    // step ran last as where the run was when it died.
    const app = harness.makeApp()
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Inline only',
      purpose: 'build',
      agentKinds: ['coder'],
    })
    const start = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: pipeline.body.id },
    )
    expect(start.status).toBe(201)
    const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!

    const dispatch = exec.diagnostics?.lastDispatch
    expect(dispatch?.agentKind).toBe('coder')
    // `inline` is what distinguishes "the engine answered this itself" from a container step
    // still waiting for the first poll to report its backend. Both are otherwise an absent
    // `executionBackend`, and they need opposite investigations.
    expect(dispatch?.executionBackend).toBe('inline')
    expect(dispatch?.failure).toBeUndefined()
  })

  it("maps a polled job's structured failureCause → AgentFailureKind and surfaces the detail", async () => {
    // The harness now reports a STRUCTURED `failureCause` (+ extended `detail`) on a failed
    // job view; the engine must classify the failure from it WITHOUT regex-matching the error
    // — a watchdog `inactivity-timeout` becomes `timeout`, and the harness detail is surfaced.
    // Asserted identically on both runtimes so a facade/transport that drops the cause (the
    // way the Node pool transport once did) fails here instead of silently degrading to `agent`.
    const app = harness.makeApp({
      asyncKinds: ['coder'],
      pollFailKinds: ['coder'],
      pollFailCause: 'inactivity-timeout',
    })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build only',
      purpose: 'build',
      agentKinds: ['coder'],
    })
    const start = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: pipeline.body.id },
    )
    expect(start.status).toBe(201)
    const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    expect(exec.status).toBe('failed')
    // The watchdog cause classifies as `timeout`, not the generic `agent`.
    expect(exec.failure?.kind).toBe('timeout')
    // The harness's extended diagnostic is surfaced as the failure detail.
    expect(exec.failure?.detail).toContain('Phase timings')
    // The step's container is surfaced as errored (the run details show the container
    // faulted), persisted before the failure funnels through `failRun`.
    const coderStep = exec.steps.find((s) => s.agentKind === 'coder')!
    expect(coderStep.container?.status).toBe('errored')
  })

  it('re-dispatches a step whose work-branch push was refused, instead of failing the run', async () => {
    // `branch-contended` is the one git fault the engine can resolve by itself: the refused push
    // means the branch already carries commits, so a fresh dispatch RESUMES it and the agent
    // continues on top rather than against them. Asserted on both runtimes because the recovery is
    // a persisted step counter plus a re-dispatch, and a facade that dropped either would instead
    // fail the run on a rejection the harness deliberately made recoverable.
    const app = harness.makeApp({
      confidence: 1,
      asyncKinds: ['coder'],
      pollFailKinds: ['coder'],
      pollFailCause: 'branch-contended',
      // Only the first job fails: the point is that the SECOND one runs. Failing forever would
      // assert nothing about the recovery, since an unrecovered run also ends `failed`.
      pollFailOnce: true,
      // And the second job has to be a genuinely NEW job, which is what this mode models: ids come
      // off the run's dispatch epoch (as the container executor's do) and a finished job's result is
      // CACHED rather than recomputed. So a re-dispatch under the failed job's own id replays the
      // failure and this test goes red, which is the production bug the epoch exists to prevent.
      pooledContainer: true,
    })
    const { workspace } = await app.createWorkspace()
    const wsId = workspace.id
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Build only',
      purpose: 'build',
      agentKinds: ['coder'],
    })
    const start = await app.call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: pipeline.body.id },
    )
    expect(start.status).toBe(201)
    const exec = (await app.drive(wsId)).find((e) => e.blockId === 'task_login')!
    // The run finished its work rather than dying on delivery mechanics. `?? null` because the two
    // facades spell "no failure recorded" differently (an absent field vs a persisted null), and
    // what this asserts is that neither holds one.
    expect(exec.status).toBe('done')
    expect(exec.failure ?? null).toBeNull()
    // And the recovery is on the record: an invisible re-dispatch reads exactly like a run that
    // never contended, which is what a post-mortem would need to tell apart.
    const coderStep = exec.steps.find((s) => s.agentKind === 'coder')!
    expect(coderStep.branchContentionRecoveries).toBe(1)
  })
}
