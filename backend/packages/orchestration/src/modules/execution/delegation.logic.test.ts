import type { AgentJobHandle, AgentRunContext, PipelineStep } from '@cat-factory/kernel'
import { defaultDelegatedExecutorRegistry, DomainError } from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import {
  buildStartStepDispatch,
  delegationContactFailed,
  planDelegatedDispatch,
} from './delegation.logic.js'
import {
  applyDelegationCancellation,
  applyDelegationRunning,
  claimDelegation,
  failDelegationDispatch,
  inFlightDelegation,
  liveDelegations,
  liveJobId,
  pollHandleFor,
  recordDispatchedJob,
  settleDelegatedJob,
  settleDelegation,
} from './step-fold.logic.js'
import { awaitingJob, delegatedPollPolicy } from './awaitingJob.logic.js'

// The engine half of a DELEGATED step: what it commits before an external executor is called, what
// it can rebuild afterwards from the step alone, and what it says when work it cannot stop is left
// running. Each of these is a place where being wrong is silent in production: a second external
// run, a poll routed at a container that was never started, a teardown that reads as clean.

const POLL = { intervalMs: 60_000, maxDurationMs: 3 * 60 * 60_000 }

function step(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return { agentKind: 'acme:impl', state: 'working', progress: 0, ...overrides } as PipelineStep
}

function claimed(): PipelineStep {
  const s = step()
  claimDelegation(s, {
    executor: 'acme:executor',
    correlationKey: 'run_1-acme:impl',
    startedAt: 1000,
    poll: POLL,
  })
  return s
}

/**
 * A step whose delegation settled and which is now running a CONTAINER job: the state every
 * `if (step.delegated)` read gets wrong. `resetStepForRerun` clears `jobId` and deliberately keeps
 * the record, because its attempt log is the evidence for why the step is being re-run.
 */
function settledThenContainerJob(): PipelineStep {
  const s = claimed()
  settleDelegation(s, { status: 'done' })
  s.jobId = 'run_1-fixer'
  return s
}

function registries(options: { registerExecutor?: boolean } = {}) {
  const agentKindRegistry = defaultAgentKindRegistry()
  agentKindRegistry.register({
    kind: 'acme:impl',
    systemPrompt: 'implement it',
    agent: { surface: 'delegated', executor: 'acme:executor' },
  })
  const delegatedExecutorRegistry = defaultDelegatedExecutorRegistry()
  if (options.registerExecutor !== false) {
    delegatedExecutorRegistry.register({
      id: 'acme:executor',
      presentation: { label: 'Acme', icon: 'i-lucide-bot', description: 'Acme runs it' },
      poll: POLL,
      telemetry: 'not-reported',
      workBranch: 'executor-creates',
      create: () => ({
        start: async () => ({ externalId: 'x' }),
        poll: async () => ({ state: 'running' }),
      }),
    })
  }
  return { agentKindRegistry, delegatedExecutorRegistry }
}

const context: AgentRunContext = {
  agentKind: 'acme:impl',
  pipelineName: 'P',
  stepIndex: 0,
  isFinalStep: true,
  executionId: 'run_1',
  workspaceId: 'ws_1',
  block: { id: 'blk_1', title: 't', type: 'service', description: 'd' },
  priorOutputs: [],
  decisions: [],
  resolvedDecision: null,
}

describe('planDelegatedDispatch', () => {
  it('mints the correlation key from the run, the kind and the dispatch epoch', () => {
    // The SAME id the container path uses as its harness job id, so one run's jobs stay distinct
    // whichever executor class they landed on, and so a re-dispatch cannot address the round
    // before it.
    const plan = planDelegatedDispatch(context, registries())
    expect(plan?.correlationKey).toBe('run_1-acme:impl')
    const second = planDelegatedDispatch({ ...context, dispatchEpoch: 2 }, registries())
    expect(second?.correlationKey).toBe('run_1-acme:impl-2')
  })

  it('copies the executor cadence onto the plan rather than leaving the poll to find it', () => {
    expect(planDelegatedDispatch(context, registries())?.poll).toEqual(POLL)
  })

  it('answers undefined for a kind that runs on the platform', () => {
    expect(planDelegatedDispatch({ ...context, agentKind: 'coder' }, registries())).toBeUndefined()
  })

  it('REFUSES a delegated kind whose executor this build does not register', () => {
    // The mothership case, and the reason this is a refusal rather than a fallback: a node
    // resolves its kinds from the mothership and boot-validates none of them, so falling through
    // to the container executor would run a step the deployment declared as external inside the
    // platform's own harness, against the repository, looking successful.
    let thrown: unknown
    try {
      planDelegatedDispatch(context, registries({ registerExecutor: false }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DomainError)
    expect((thrown as DomainError).details?.reason).toBe('delegated_executor_unwired')
  })
})

describe('claimDelegation', () => {
  it('commits the correlation key as the job id, so a replay re-attaches instead of re-starting', () => {
    // The deadliest trap in the flow: both drivers replay, and a second `start()` is a second
    // external run and a second pull request for one task.
    const s = claimed()
    expect(s.jobId).toBe('run_1-acme:impl')
    expect(s.delegated?.status).toBe('starting')
    expect(s.delegated?.externalId).toBeNull()
  })

  it('APPENDS to the attempt log across a re-run rather than clearing it', () => {
    // The previous attempt's URL is the evidence for why the step is being re-run, and the
    // platform holds nothing else about work that happened elsewhere.
    const s = claimed()
    settleDelegation(s, { status: 'failed', outcome: 'the workflow failed', url: 'https://ci/1' })
    claimDelegation(s, {
      executor: 'acme:executor',
      correlationKey: 'run_1-acme:impl-1',
      startedAt: 2000,
      poll: POLL,
    })
    expect(s.delegated?.attempts).toHaveLength(2)
    expect(s.delegated?.attempts[0]).toMatchObject({
      outcome: 'the workflow failed',
      url: 'https://ci/1',
    })
  })
})

describe('recordDispatchedJob', () => {
  it('stamps NO container for a delegated dispatch', () => {
    // A delegated step has no container: stamping one renders it as a container that never
    // reports a phase, an id or an address, and puts it in front of the reclaim that kills
    // containers by run.
    const s = claimed()
    const handle = {
      jobId: 'run_1-acme:impl',
      delegated: { executor: 'acme:executor', externalId: '99', url: 'https://ci/99' },
    } as AgentJobHandle
    recordDispatchedJob(s, handle, 'acme:impl')
    expect(s.container).toBeUndefined()
    expect(s.delegated).toMatchObject({ status: 'running', externalId: '99', url: 'https://ci/99' })
    expect(s.delegated?.attempts[0]).toMatchObject({ externalId: '99', startedAt: 1000 })
  })

  it('still stamps the container for an ordinary dispatch', () => {
    const s = step()
    recordDispatchedJob(s, { jobId: 'job_1' } as AgentJobHandle, 'coder')
    expect(s.container).toEqual({ status: 'up' })
  })
})

describe('pollHandleFor', () => {
  it('rebuilds the executor route from the step alone', () => {
    // The poll runs in another process after a durable replay and has nothing else to route on.
    const s = claimed()
    recordDispatchedJob(
      s,
      {
        jobId: 'run_1-acme:impl',
        delegated: { executor: 'acme:executor', externalId: '99' },
      } as AgentJobHandle,
      'acme:impl',
    )
    expect(pollHandleFor(s, 'ws_1', 'run_1', 'blk_1').delegated).toEqual({
      executor: 'acme:executor',
      externalId: '99',
    })
  })

  it('falls back to the correlation key when the claim never got an external id', () => {
    // The replay case rather than an edge: the claim commits before `start()`, so a process that
    // died in between leaves a record with a status and no external id, and the executor is asked
    // to recover its own run by that key instead of the platform starting a second one.
    expect(pollHandleFor(claimed(), 'ws_1', 'run_1', 'blk_1').delegated).toEqual({
      executor: 'acme:executor',
      externalId: 'run_1-acme:impl',
    })
  })

  it('carries the branch pair AND the target repo, neither of which a poll can derive', () => {
    const s = claimed()
    recordDispatchedJob(
      s,
      {
        jobId: 'run_1-acme:impl',
        delegated: {
          executor: 'acme:executor',
          externalId: '99',
          branches: { base: 'main', work: 'cat-factory/blk_1' },
          repo: { owner: 'acme', name: 'widgets' },
        },
      } as AgentJobHandle,
      'acme:impl',
    )
    expect(pollHandleFor(s, 'ws_1', 'run_1', 'blk_1').delegated).toMatchObject({
      branches: { base: 'main', work: 'cat-factory/blk_1' },
      repo: { owner: 'acme', name: 'widgets' },
    })
  })

  it('routes NOTHING at the external executor once a container job is in flight on the step', () => {
    // A step whose own work was delegated can still dispatch a container job afterwards (a helper
    // round, a re-run under an overriding kind), and the delegation record outlives that by
    // design. Attaching the slice anyway hands the CONTAINER job's id to the external executor,
    // which polls its system for a run that does not exist, while the real container job is never
    // polled at all.
    const s = settledThenContainerJob()
    expect(pollHandleFor(s, 'ws_1', 'run_1', 'blk_1').delegated).toBeUndefined()
  })
})

describe('inFlightDelegation', () => {
  it('answers the record when the job in flight IS the delegated one', () => {
    expect(inFlightDelegation(claimed())?.executor).toBe('acme:executor')
  })

  it('answers nothing for a step that never delegated', () => {
    expect(inFlightDelegation(step({ jobId: 'run_1-coder' }))).toBeUndefined()
  })

  it('answers nothing once a LATER job supersedes the settled delegation', () => {
    // The one question every reader of `step.delegated` actually has. Without it a later container
    // job flips a settled record back to `running`, stamps a container phase on external work that
    // finished hours ago, and overwrites its outcome on settle.
    expect(inFlightDelegation(settledThenContainerJob())).toBeUndefined()
  })
})

describe('applyDelegationRunning', () => {
  it('folds a url that only became known after the start', () => {
    const s = claimed()
    expect(applyDelegationRunning(s, { url: 'https://ci/99', phase: 'queued' })).toBe(true)
    expect(s.delegated).toMatchObject({ status: 'running', url: 'https://ci/99', phase: 'queued' })
  })

  it('reports no change on an idle poll, so the run is not re-persisted per tick', () => {
    const s = claimed()
    applyDelegationRunning(s, { url: 'https://ci/99' })
    expect(applyDelegationRunning(s, { url: 'https://ci/99' })).toBe(false)
  })

  it('folds nothing onto a step this engine never claimed', () => {
    expect(applyDelegationRunning(step(), { url: 'https://ci/99' })).toBe(false)
  })

  it('records an external id the POLL recovered, onto the record and its attempt', () => {
    // A system that answers its dispatch with no id (`workflow_dispatch` replies 204) returns the
    // correlation key and recovers the real one afterwards. Uncarried, the record keeps the key
    // and every later poll re-runs the bounded scan that found the run, which on a busy
    // repository eventually misses it: a live external run then reads as one that never appeared.
    const s = claimed()
    expect(applyDelegationRunning(s, { externalId: '4242', url: 'https://ci/4242' })).toBe(true)
    expect(s.delegated?.externalId).toBe('4242')
    expect(s.delegated?.attempts.at(-1)).toMatchObject({ externalId: '4242' })
  })

  it('never unlearns a recorded id when a later poll reports none', () => {
    const s = claimed()
    applyDelegationRunning(s, { externalId: '4242' })
    applyDelegationRunning(s, { phase: 'in_progress' })
    expect(s.delegated?.externalId).toBe('4242')
  })
})

describe('settleDelegatedJob', () => {
  // Its callers are the poll path's ONE settle, ahead of the helper router: a delegated helper
  // round (a gate's `ci-fixer`, an `on-call`, a tester's `fixer`) never reaches the completion
  // path, so settling only there left every such record reading `running` for ever.
  it('settles a finished round as done, carrying the link and the branch it landed on', () => {
    const s = claimed()
    settleDelegatedJob(s, {
      state: 'done',
      delegated: { url: 'https://ci/7', branch: 'cat-factory/blk_1' },
    })
    expect(s.delegated).toMatchObject({
      status: 'done',
      url: 'https://ci/7',
      branch: 'cat-factory/blk_1',
    })
  })

  it('settles a FAILED round as failed, in the executor’s own words', () => {
    const s = claimed()
    settleDelegatedJob(s, { state: 'failed', error: 'The workflow run finished as "failure".' })
    expect(s.delegated?.status).toBe('failed')
    expect(s.delegated?.attempts.at(-1)?.outcome).toBe('The workflow run finished as "failure".')
  })

  it('leaves a settled record alone when a CONTAINER job later runs on the same step', () => {
    // The record outlives the work it describes, and overwriting it with a container's outcome
    // destroys the entire account of work that happened somewhere else.
    const s = settledThenContainerJob()
    settleDelegatedJob(s, { state: 'failed', error: 'the container died' })
    expect(s.delegated?.status).toBe('done')
  })
})

describe('delegatedPollPolicy', () => {
  it('derives the poll budget from the executor window, not a platform constant', () => {
    expect(delegatedPollPolicy(claimed())).toEqual({ intervalMs: 60_000, maxPolls: 180 })
  })

  it('withholds the cadence once a CONTAINER job is in flight on the same step', () => {
    // A delegated step can still dispatch a container job afterwards (a helper round, a re-run
    // under an overriding kind) and the delegation record outlives that by design. Polling that
    // container on a three-hour external schedule would be minutes of dead air per tick.
    const s = claimed()
    s.jobId = 'run_1-fixer'
    expect(delegatedPollPolicy(s)).toBeUndefined()
  })

  it('falls back to the deployment cadence for a record that declared none', () => {
    // A dispatch site that never claimed leaves a record with no executor declaration within
    // reach. Answering undefined hands the step to the deployment's own job cadence; the zero
    // window this used to synthesise derived `ceil(0/0)` = NaN, whose poll loop runs no
    // iterations at all and failed the step as un-settled before its first poll.
    const s = claimed()
    s.delegated = { ...s.delegated!, poll: null }
    expect(delegatedPollPolicy(s)).toBeUndefined()
    expect(awaitingJob(s, 0, s.jobId!)).toEqual({
      kind: 'awaiting_job',
      jobId: 'run_1-acme:impl',
      stepIndex: 0,
    })
  })

  it('withholds the cadence once the external work has settled', () => {
    const s = claimed()
    settleDelegation(s, { status: 'done' })
    expect(delegatedPollPolicy(s)).toBeUndefined()
  })

  it('carries the cadence onto the park the driver reads', () => {
    const s = claimed()
    expect(awaitingJob(s, 3, s.jobId!)).toEqual({
      kind: 'awaiting_job',
      jobId: 'run_1-acme:impl',
      stepIndex: 3,
      poll: { intervalMs: 60_000, maxPolls: 180 },
    })
  })

  it('leaves an ordinary park byte-for-byte as it was', () => {
    const s = step({ jobId: 'job_1' })
    expect(awaitingJob(s, 0, 'job_1')).toEqual({
      kind: 'awaiting_job',
      jobId: 'job_1',
      stepIndex: 0,
    })
  })
})

describe('liveDelegations / applyDelegationCancellation', () => {
  it('names every step still running somewhere else, not just the current one', () => {
    // A run parks on one step at a time, but a delegated step the run advanced past while its
    // external work was winding down is exactly what a teardown must still address.
    const running = claimed()
    const settled = claimed()
    settleDelegation(settled, { status: 'done' })
    const handles = liveDelegations(
      { id: 'run_1', blockId: 'blk_1', steps: [running, settled] },
      'ws_1',
    )
    expect(handles).toHaveLength(1)
    expect(handles[0]).toMatchObject({
      executor: 'acme:executor',
      correlationKey: 'run_1-acme:impl',
    })
  })

  it('SAYS the external work was left running when the executor could not stop it', () => {
    // Writing `cancelled` with nothing beside it would render a clean teardown over a run that
    // will finish, open its pull request and bill its tokens anyway.
    const s = claimed()
    applyDelegationCancellation({ steps: [s] }, [
      { correlationKey: 'run_1-acme:impl', cancelled: false, note: 'no cancel declared' },
    ])
    expect(s.delegated?.status).toBe('cancelled')
    expect(s.delegated?.note).toBe('no cancel declared')
  })

  it('treats an UNREPORTED handle as not cancelled', () => {
    // "We asked" and "it stopped" are different facts, and only the executor can turn the first
    // into the second.
    const s = claimed()
    applyDelegationCancellation({ steps: [s] }, undefined)
    expect(s.delegated?.status).toBe('cancelled')
    expect(s.delegated?.note).toContain('may still be running')
  })

  it('leaves a settled record alone', () => {
    const s = claimed()
    settleDelegation(s, { status: 'done' })
    expect(applyDelegationCancellation({ steps: [s] }, undefined)).toBe(false)
    expect(s.delegated?.status).toBe('done')
  })
})

describe('failDelegationDispatch', () => {
  it('keeps the claim LIVE when the executor was called and never answered', () => {
    // The teardown reads `liveDelegations`, which skips a settled record. Settled here, a lost
    // response left an external run to finish, open its pull request and bill its tokens on a
    // task the board reported as failed, with nothing anywhere saying it was still alive.
    const s = claimed()
    failDelegationDispatch(s, { error: 'fetch failed', contacted: true })
    expect(s.delegated?.status).toBe('starting')
    expect(s.delegated?.note).toBe('fetch failed')
    expect(s.delegated?.attempts.at(-1)?.outcome).toBe('fetch failed')
    expect(liveDelegations({ id: 'run_1', blockId: 'blk_1', steps: [s] }, 'ws_1')).toHaveLength(1)
  })

  it('SETTLES the claim when nothing was contacted, so no teardown raises a false alarm', () => {
    const s = claimed()
    failDelegationDispatch(s, { error: 'no repository linked', contacted: false })
    expect(s.delegated?.status).toBe('failed')
    expect(liveDelegations({ id: 'run_1', blockId: 'blk_1', steps: [s] }, 'ws_1')).toEqual([])
  })

  it('drops the handle either way, so a replay dispatches instead of polling a ghost', () => {
    // The failed attempt recorded no dispatch, so the epoch has not moved and the re-dispatch
    // carries the SAME correlation key: the executor recognises its own run if one started.
    for (const contacted of [true, false]) {
      const s = claimed()
      failDelegationDispatch(s, { error: 'boom', contacted })
      expect(s.jobId).toBeUndefined()
    }
  })
})

describe('delegationContactFailed', () => {
  it('reads the executor’s own statement rather than guessing from the throw', () => {
    expect(
      delegationContactFailed(
        new DomainError('unavailable', 'the executor refused', {
          reason: 'delegated_executor_failed',
        }),
      ),
    ).toBe(true)
    expect(
      delegationContactFailed(
        new DomainError('conflict', 'no repo', { reason: 'github_not_connected' }),
      ),
    ).toBe(false)
    expect(delegationContactFailed(new Error('boom'))).toBe(false)
  })
})

describe('buildStartStepDispatch', () => {
  function start(options: {
    persisted?: PipelineStep[]
    startJob?: (context: AgentRunContext) => Promise<AgentJobHandle>
  }) {
    const persisted = options.persisted ?? []
    const dispatch = buildStartStepDispatch({
      ...registries(),
      clock: { now: () => 1000 },
      persistAndEmit: async (_ws: string, instance: { steps: PipelineStep[] }) => {
        // Snapshot what a replay would actually READ: a claim only counts once it is on disk.
        persisted.push(structuredClone(instance.steps[0]!))
      },
    })
    return (s: PipelineStep, ctx: AgentRunContext = context) =>
      dispatch({
        workspaceId: 'ws_1',
        instance: { id: 'run_1', blockId: 'blk_1', steps: [s] } as never,
        context: ctx,
        step: s,
        executor: {
          startJob:
            options.startJob ??
            (async () => ({
              jobId: 'run_1-acme:impl',
              runId: 'run_1',
              delegated: { executor: 'acme:executor', externalId: 'ext-9' },
            })),
        },
      })
  }

  it('commits the claim BEFORE the executor is called', async () => {
    const persisted: PipelineStep[] = []
    const seen: PipelineStep[] = []
    const s = step()
    await start({
      persisted,
      startJob: async () => {
        // What the executor's own system sees at the moment it is contacted.
        seen.push(structuredClone(s))
        return {
          jobId: 'run_1-acme:impl',
          runId: 'run_1',
          delegated: { executor: 'acme:executor', externalId: 'ext-9' },
        }
      },
    })(s)
    expect(persisted[0]?.delegated).toMatchObject({
      status: 'starting',
      correlationKey: 'run_1-acme:impl',
    })
    expect(persisted[0]?.jobId).toBe('run_1-acme:impl')
    expect(seen[0]?.delegated?.status).toBe('starting')
  })

  it('stamps NO container on a delegated dispatch', async () => {
    // A stamped container renders the step as a machine the platform never started, and hands it
    // to the reclaim that kills containers by run.
    const s = step()
    await start({})(s)
    expect(s.container).toBeUndefined()
    expect(s.delegated?.status).toBe('running')
    expect(s.delegated?.externalId).toBe('ext-9')
  })

  it('opens the container cold boot for a kind that runs on the platform', async () => {
    const s = step()
    await start({
      startJob: async () => ({ jobId: 'run_1-coder', runId: 'run_1' }),
    })(s, { ...context, agentKind: 'coder' })
    expect(s.delegated).toBeUndefined()
    expect(s.container).toEqual({ status: 'up' })
  })

  it('answers the job id the dispatch stamped', async () => {
    const s = step()
    const started = await start({})(s)
    expect(started.jobId).toBe('run_1-acme:impl')
    expect(started.handle.delegated?.externalId).toBe('ext-9')
  })

  describe('a dispatch that throws', () => {
    // The half that was written out per site and held at exactly one of them: a claim committed
    // and then abandoned leaves the run polling a job that may never have started, until the poll
    // budget is spent, reporting a timeout instead of the dispatch failure that happened.
    it('drops the job id and settles a claim nothing contacted, then rethrows', async () => {
      const persisted: PipelineStep[] = []
      const s = step()
      const boom = new DomainError('conflict', 'no repo', { reason: 'github_not_connected' })
      await expect(start({ persisted, startJob: () => Promise.reject(boom) })(s)).rejects.toBe(boom)
      expect(s.jobId).toBeUndefined()
      expect(s.delegated?.status).toBe('failed')
      // PERSISTED, because the durable drivers re-read the run from storage when they fail it.
      expect(persisted.at(-1)?.jobId).toBeUndefined()
      expect(persisted.at(-1)?.delegated?.status).toBe('failed')
    })

    it('leaves a claim the executor DID receive open, for the teardown to ask about', async () => {
      const s = step()
      const boom = new DomainError('unavailable', 'the executor blew up', {
        reason: 'delegated_executor_failed',
      })
      await expect(start({ startJob: () => Promise.reject(boom) })(s)).rejects.toBe(boom)
      expect(s.jobId).toBeUndefined()
      expect(s.delegated?.status).toBe('starting')
      expect(s.delegated?.note).toContain('blew up')
    })

    it('errors the container for a kind that runs on the platform', async () => {
      const s = step()
      await expect(
        start({ startJob: () => Promise.reject(new Error('no capacity')) })(s, {
          ...context,
          agentKind: 'coder',
        }),
      ).rejects.toThrow('no capacity')
      expect(s.container).toEqual({ status: 'errored' })
    })

    it('reports the dispatch failure rather than a persist that then failed', async () => {
      // The fold is best-effort on purpose: the caller's own error is the one worth reporting,
      // and the claim it could not write is re-derived from the record's status on the next
      // advance anyway (see `liveJobId`).
      const s = step()
      const dispatch = buildStartStepDispatch({
        ...registries(),
        clock: { now: () => 1000 },
        persistAndEmit: async (_ws: string, instance: { steps: PipelineStep[] }) => {
          if (instance.steps[0]?.jobId) return
          throw new Error('storage is down')
        },
      })
      await expect(
        dispatch({
          workspaceId: 'ws_1',
          instance: { id: 'run_1', blockId: 'blk_1', steps: [s] } as never,
          context,
          step: s,
          executor: { startJob: () => Promise.reject(new Error('the executor refused')) },
        }),
      ).rejects.toThrow('the executor refused')
    })
  })

  describe('a claim the dispatch never answered', () => {
    // The crash window between the committed claim and `start()` returning: a workerd isolate
    // kill, a pg-boss worker restart, a deploy drain.
    it('is not a live job, so the next advance re-dispatches instead of polling', () => {
      const s = claimed()
      expect(s.jobId).toBe('run_1-acme:impl')
      expect(liveJobId(s)).toBeUndefined()
    })

    it('re-dispatches under the SAME correlation key, adding no attempt', async () => {
      // The port requires `start` to be idempotent per correlation key, which is what makes
      // re-calling it safe; counted as a second attempt, a process that keeps dying would fill
      // the step's evidence log with rounds that never reached anybody's runner.
      const s = claimed()
      const started = await start({})(s)
      expect(started.jobId).toBe('run_1-acme:impl')
      expect(s.delegated?.attempts).toHaveLength(1)
      expect(liveJobId(s)).toBe('run_1-acme:impl')
    })

    it('appends an attempt for a claim opened after an earlier round settled', async () => {
      const s = claimed()
      settleDelegation(s, { status: 'failed', outcome: 'the workflow failed' })
      s.jobId = undefined
      await start({})(s)
      expect(s.delegated?.attempts).toHaveLength(2)
    })
  })
})
