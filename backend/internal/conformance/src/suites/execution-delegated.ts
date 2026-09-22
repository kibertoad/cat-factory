import { describe, expect, it } from 'vitest'
import type { ExecutionInstance, GateProbe, GateRegistry, Pipeline } from '@cat-factory/kernel'
import { gateRegistryWithBuiltins } from '@cat-factory/gates'
import type { ConformanceHarness } from '../harness.js'
import {
  CONFORMANCE_DELEGATED_EXECUTOR_ID,
  CONFORMANCE_DELEGATED_HELPER_KIND,
  CONFORMANCE_DELEGATED_KIND,
  delegatedKindRegistry,
  fakeDelegatedExecutor,
  fakeDelegatedRegistry,
  fakeDelegationRepoFiles,
  type FakeDelegatedExecutorOptions,
  type FakeDelegationRepo,
} from '../FakeDelegatedExecutor.js'

// Cross-runtime conformance for DELEGATED EXECUTION: a step whose work runs in a system the
// deployment already operates, while cat-factory keeps the orchestration around it
// (`docs/initiatives/delegated-executors.md`).
//
// It is here rather than in a facade's own suite for a specific reason: a delegated step's entire
// state is what the claim persisted. There is no container to re-address and no runner to ask, so
// every fact the poll needs (which executor, which external id, which cadence, which attempt)
// has to survive a round trip through D1 and through Postgres identically. A driver that dropped
// the nested attempt array, or a store that lost the record on a settle, would fail nothing else.

function makeApp(
  harness: ConformanceHarness,
  options: FakeDelegatedExecutorOptions = {},
  repo?: FakeDelegationRepo,
) {
  const { definition, calls } = fakeDelegatedExecutor(options)
  const agentKindRegistry = delegatedKindRegistry()
  const app = harness.makeApp(
    {},
    {
      agentKindRegistry,
      delegatedExecutorRegistry: fakeDelegatedRegistry(definition),
      ...(repo ? { delegatedRepoFiles: repo.repoFiles } : {}),
    },
  )
  return { app, calls }
}

/** Start a run of a one-step pipeline whose only step is the delegated kind. */
async function runDelegated(app: ReturnType<ConformanceHarness['makeApp']>) {
  const { workspace } = await app.createWorkspace()
  const pipeline = await app.call<Pipeline>('POST', `/workspaces/${workspace.id}/pipelines`, {
    name: 'External build',
    purpose: 'build',
    agentKinds: [CONFORMANCE_DELEGATED_KIND],
  })
  const start = await app.call('POST', `/workspaces/${workspace.id}/blocks/task_login/executions`, {
    pipelineId: pipeline.body.id,
  })
  expect(start.status).toBe(201)
  return { workspaceId: workspace.id }
}

function delegatedStep(exec: ExecutionInstance) {
  return exec.steps.find((s) => s.agentKind === CONFORMANCE_DELEGATED_KIND)!
}

export function defineDelegatedConformance(harness: ConformanceHarness): void {
  describe('execution engine: delegated executor', () => {
    it('dispatches, polls and settles a step on an external executor', async () => {
      const { app, calls } = makeApp(harness)
      const { workspaceId } = await runDelegated(app)

      const exec = (await app.drive(workspaceId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      const step = delegatedStep(exec)
      expect(step.state).toBe('done')
      expect(step.output).toBe('Implemented the change on the work branch.')
      // The executor was asked ONCE. A second start is a second external run and a second pull
      // request for one task, and it is the whole reason the claim commits before the dispatch.
      expect(calls.starts).toHaveLength(1)
      expect(calls.polls.length).toBeGreaterThan(0)
    })

    it('persists the delegation record through this runtime’s step store', async () => {
      const { app } = makeApp(harness)
      const { workspaceId } = await runDelegated(app)
      const exec = (await app.drive(workspaceId)).find((e) => e.blockId === 'task_login')!
      const step = delegatedStep(exec)
      // Everything a human needs to go and look at somebody else's logs, and everything a poll
      // would need if this run were re-driven in a fresh process.
      expect(step.delegated).toMatchObject({
        executor: CONFORMANCE_DELEGATED_EXECUTOR_ID,
        status: 'done',
        url: 'https://ci.example/run/1',
      })
      expect(step.delegated?.externalId).toContain('ext-')
      // The key the executor was asked to make its run findable by, and the step's job id at the
      // claim. It is what a poll re-attaches with when a process died between the claim and the
      // executor's answer, so it has to survive the store.
      expect(step.delegated?.correlationKey).toBe(`${exec.id}-${CONFORMANCE_DELEGATED_KIND}`)
      // The attempt log is a nested array inside a JSON column on both runtimes: the exact shape a
      // driver can round-trip wrong while every flat field survives.
      expect(step.delegated?.attempts).toHaveLength(1)
      expect(step.delegated?.attempts[0]?.externalId).toBe(step.delegated?.externalId)
      // And NO container was stamped: a delegated step has none, and one here would render as a
      // container that never reports a phase and be addressed by the container reclaim.
      expect(step.container ?? null).toBeNull()
    })

    it('records the pull request the external executor opened on the block', async () => {
      // The whole point of a step-level seam: everything downstream of the settle is the engine
      // the platform already has.
      const { app } = makeApp(harness)
      const { workspaceId } = await runDelegated(app)
      await app.drive(workspaceId)
      const board = await app.call<{ blocks: { id: string; pullRequest?: { number: number } }[] }>(
        'GET',
        `/workspaces/${workspaceId}`,
      )
      const block = board.body.blocks.find((b) => b.id === 'task_login')
      expect(block?.pullRequest?.number).toBe(42)
    })

    it('hands the executor the brief the platform composed, with the run’s own repo and branches', async () => {
      const { app, calls } = makeApp(harness)
      const { workspaceId } = await runDelegated(app)
      await app.drive(workspaceId)
      const brief = calls.starts[0]!
      expect(brief.agentKind).toBe(CONFORMANCE_DELEGATED_KIND)
      expect(brief.repo).toMatchObject({ owner: 'acme', name: 'widgets' })
      expect(brief.branches).toEqual({ base: 'main', work: 'cat-factory/task_login' })
      expect(brief.systemPrompt).toContain('You implement the change in the external system.')
      // The correlation key is what the executor is asked to make its own run recoverable by, and
      // it is the step's job id on both runtimes.
      expect(brief.correlationKey).toBe(brief.runId + '-' + CONFORMANCE_DELEGATED_KIND)
    })

    it('creates the work branch before `start` when the executor declared the platform does', async () => {
      // The one VCS write the delegated path makes, and the only assertion that covers a facade
      // FORGETTING to hand the arm a repo binding: the Worker threads it out of one assembly and
      // Node out of another, and the symptom of omitting it is an external run checking out a
      // branch nobody created, hours later and somewhere else.
      const repo = fakeDelegationRepoFiles({ main: 'sha-main' })
      const { app, calls } = makeApp(harness, { workBranch: 'platform-creates' }, repo)
      const { workspaceId } = await runDelegated(app)
      const exec = (await app.drive(workspaceId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      expect(repo.created).toEqual([{ branch: 'cat-factory/task_login', fromSha: 'sha-main' }])
      // The executor saw a branch that was already there. `heads` is the repository's state at the
      // end, so this pins the ORDER the assertion above cannot: created, then dispatched.
      expect(calls.starts).toHaveLength(1)
      expect(repo.heads['cat-factory/task_login']).toBe('sha-main')
    })

    it('refuses a `platform-creates` dispatch when the deployment has no repo binding', async () => {
      // No `delegatedRepoFiles`, which is a deployment that configured no VCS provider. Refused
      // rather than started: the executor SAID its system cannot make the branch, so dispatching
      // anyway buys a checkout failure in somebody else's CI instead of a failure here.
      const { app, calls } = makeApp(harness, { workBranch: 'platform-creates' })
      const { workspaceId } = await runDelegated(app)
      const exec = (await app.drive(workspaceId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('failed')
      expect(calls.starts).toEqual([])
    })

    it('fails the run with the executor’s own reason when the external work fails', async () => {
      const { app } = makeApp(harness, {
        updates: [{ state: 'failed', error: 'the external workflow failed', detail: 'exit 1' }],
      })
      const { workspaceId } = await runDelegated(app)
      const exec = (await app.drive(workspaceId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('failed')
      expect(exec.failure?.message).toContain('the external workflow failed')
      // The record keeps the link: the executor's own logs are the whole post-mortem, and a failed
      // delegated step with no link is a dead end.
      const step = delegatedStep(exec)
      expect(step.delegated?.status).toBe('failed')
      expect(step.delegated?.url).toBe('https://ci.example/run/1')
    })

    it('re-dispatches ONCE when the executor calls its failure survivable', async () => {
      // An external run cancelled by a runner-pool restart is not a verdict on the work, and the
      // executor is the only thing that can say so. The re-drive is engine behaviour with nothing
      // runtime-specific in it, but the state it depends on is entirely in the step store: the
      // budget counter, the settled first attempt, and the appended second one all round-trip
      // through a JSON column on one runtime and through another on the other.
      const { app, calls } = makeApp(harness, {
        updates: [
          { state: 'failed', error: 'the runner pool restarted', retryable: true },
          { state: 'done', result: { summary: 'Implemented on the second attempt.' } },
        ],
      })
      const { workspaceId } = await runDelegated(app)
      const exec = (await app.drive(workspaceId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      // TWO starts, under DIFFERENT correlation keys: the dispatch epoch moved, so the executor
      // is asked to start a fresh run rather than to recognise the one that just failed.
      expect(calls.starts).toHaveLength(2)
      expect(calls.starts[0]?.correlationKey).not.toBe(calls.starts[1]?.correlationKey)
      const step = delegatedStep(exec)
      expect(step.delegatedRetries).toBe(1)
      // The first attempt survives with its own outcome: the platform holds nothing else about
      // work that happened somewhere else, and a re-driven step that reports one attempt reads
      // like a step that ran once.
      expect(step.delegated?.attempts).toHaveLength(2)
      expect(step.delegated?.attempts[0]?.outcome).toContain('runner pool restarted')
      expect(step.delegated?.status).toBe('done')
    })

    it('stops the external work when the run gives up on it', async () => {
      // An external run the platform stops waiting for is still RUNNING somewhere. The teardown
      // path every terminal failure funnels through has to reach it, or the run finishes, opens
      // its pull request and bills its tokens with nothing left pointing at it.
      const { app, calls } = makeApp(harness, {
        updates: [{ state: 'running', url: 'https://ci.example/run/1' }],
      })
      const { workspaceId } = await runDelegated(app)
      const exec = (await app.drive(workspaceId)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('failed')
      expect(calls.cancels).toHaveLength(1)
      expect(calls.cancels[0]?.executor).toBe(CONFORMANCE_DELEGATED_EXECUTOR_ID)
      expect(delegatedStep(exec).delegated?.status).toBe('cancelled')
    })

    it('SAYS the external work was left running when the executor cannot stop it', async () => {
      // The disposition that must never read as a clean teardown: the external run carries on, and
      // the person looking at this record is the one who has to go and stop it.
      const { app } = makeApp(harness, {
        cancelable: false,
        updates: [{ state: 'running', url: 'https://ci.example/run/1' }],
      })
      const { workspaceId } = await runDelegated(app)
      const exec = (await app.drive(workspaceId)).find((e) => e.blockId === 'task_login')!
      const record = delegatedStep(exec).delegated
      expect(record?.status).toBe('cancelled')
      expect(record?.note).toContain('declares no cancel')
    })

    it('settles the record of a delegated GATE HELPER, whose round never reaches the settle path', async () => {
      // A helper is an ordinary dispatch of an agent kind, so a deployment whose `ci-fixer` runs
      // on its own external loop reaches the gate's dispatch site. The round it finishes is routed
      // away from the completion path by the settled-helper router, which is how every delegated
      // helper's record came to read `running` for ever: the teardown then asks its executor to
      // cancel a run that had finished, the spend-gap fold skipped it as still in flight, and the
      // card said "running externally" over a job that was long done.
      const { definition, calls } = fakeDelegatedExecutor({
        updates: [{ state: 'done', result: { summary: 'Fixed it externally.' } }],
      })
      const agentKindRegistry = delegatedKindRegistry()
      const gateRegistry: GateRegistry = gateRegistryWithBuiltins()
      let probes = 0
      gateRegistry.register('external-fix-gate', () => ({
        kind: 'external-fix-gate',
        helperKind: CONFORMANCE_DELEGATED_HELPER_KIND,
        wired: () => true,
        unwiredOutput: 'gate skipped',
        // Red once, so the helper is dispatched; clean afterwards, so the re-probe advances.
        probe: async (): Promise<GateProbe> =>
          probes++ === 0
            ? { status: 'fail', headSha: 'sha', failureSummary: 'the build is red' }
            : { status: 'pass', headSha: 'sha', passOutput: 'the build is green' },
        onExhausted: async () => ({ error: 'still red' }),
      }))
      const app = harness.makeApp(
        {},
        {
          agentKindRegistry,
          gateRegistry,
          delegatedExecutorRegistry: fakeDelegatedRegistry(definition),
        },
      )
      const { workspace } = await app.createWorkspace()
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${workspace.id}/pipelines`, {
        name: 'Build + external fix gate',
        purpose: 'build',
        agentKinds: ['coder', 'external-fix-gate'],
      })
      const start = await app.call(
        'POST',
        `/workspaces/${workspace.id}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(start.status).toBe(201)

      const exec = (await app.drive(workspace.id)).find((e) => e.blockId === 'task_login')!
      expect(exec.status).toBe('done')
      expect(calls.starts).toHaveLength(1)
      const gateStep = exec.steps.find((s) => s.agentKind === 'external-fix-gate')!
      expect(gateStep.state).toBe('done')
      // The helper's external round is SETTLED, not left live: the gate advanced on its re-probe
      // and the record is the platform's whole account of work that happened somewhere else.
      expect(gateStep.delegated?.status).toBe('done')
      expect(gateStep.delegated?.executor).toBe(CONFORMANCE_DELEGATED_EXECUTOR_ID)
      // And nothing asked the executor to stop a run it had already finished.
      expect(calls.cancels).toHaveLength(0)
    })
  })
}
