import type { AgentJobHandle, AgentRunContext, PipelineStep } from '@cat-factory/kernel'
import { defaultDelegatedExecutorRegistry, DomainError } from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import { planDelegatedDispatch } from './delegation.logic.js'
import {
  applyDelegationCancellation,
  applyDelegationRunning,
  claimDelegation,
  liveDelegations,
  pollHandleFor,
  recordDispatchedJob,
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
    expect(pollHandleFor(s, 'ws_1', 'run_1').delegated).toEqual({
      executor: 'acme:executor',
      externalId: '99',
    })
  })

  it('falls back to the correlation key when the claim never got an external id', () => {
    // The replay case rather than an edge: the claim commits before `start()`, so a process that
    // died in between leaves a record with a status and no external id, and the executor is asked
    // to recover its own run by that key instead of the platform starting a second one.
    expect(pollHandleFor(claimed(), 'ws_1', 'run_1').delegated).toEqual({
      executor: 'acme:executor',
      externalId: 'run_1-acme:impl',
    })
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
    const handles = liveDelegations({ id: 'run_1', steps: [running, settled] })
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
