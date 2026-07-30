import type {
  Block,
  BlockRepository,
  ExecutionEventPublisher,
  ExecutionInstance,
  Logger,
  RunLifecycleEvent,
  RunLifecycleSink,
  SubscriptionActivationRepository,
} from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { RunStateMachine } from './RunStateMachine.js'

// The outbound run-lifecycle push rides the terminal-emit funnel — the same place the Kaizen
// scheduler and the activation cleanup hook — because a run reaches `done` from four independent
// sites and a hook at each would silently drift. These pin what that choice has to guarantee: only
// the TERMINAL edges push, the failure record rides `run.failed` (scrubbed, since this projection
// leaves the deployment), the headless internal anchor is suppressed exactly as the live push is,
// and an unwired sink changes nothing.
//
// Two of them pin the ORDERING rules the push has to obey, because nothing else would fail if it
// stopped obeying them: it runs LAST among the terminal hooks and behind `runBestEffort`, so a
// sink that breaks its no-throw contract cannot strand the credential cleanup; and it reads no
// block of its own, because the start path hands it one it already holds.

function makeInstance(overrides: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'task_login',
    pipelineId: 'pl_full',
    pipelineName: 'Full',
    steps: [],
    currentStep: 0,
    status: 'running',
    createdAt: 1_699_000_000_000,
    ...overrides,
  }
}

function makeMachine(
  block: Block | null,
  sink?: RunLifecycleSink,
  extra: {
    subscriptionActivations?: SubscriptionActivationRepository
    logger?: Logger
  } = {},
) {
  const events: ExecutionEventPublisher = {
    executionChanged: async () => {},
  } as unknown as ExecutionEventPublisher
  const blockRepository: BlockRepository = {
    get: async () => block,
  } as unknown as BlockRepository
  return new RunStateMachine({
    executionRepository: {} as never,
    blockRepository,
    events,
    workRunner: {} as never,
    agentExecutor: {} as never,
    idGenerator: {} as never,
    clock: { now: () => 1_700_000_000_000 },
    stepGraph: {} as never,
    ...(sink ? { runLifecycleSink: sink } : {}),
    ...extra,
  })
}

function recordingSink(): { sink: RunLifecycleSink; delivered: RunLifecycleEvent[] } {
  const delivered: RunLifecycleEvent[] = []
  return {
    delivered,
    sink: {
      runTransitioned: async (_workspaceId: string, event: RunLifecycleEvent) => {
        delivered.push(event)
      },
    },
  }
}

const task = {
  id: 'task_login',
  title: 'Add passkey login',
  pullRequest: { url: 'https://vcs.test/pr/7' },
} as unknown as Block
const internalAnchor = { id: 'task_login', title: 'brief', internal: true } as unknown as Block

describe('RunStateMachine — outbound run-lifecycle push', () => {
  it('pushes run.completed with the task, pipeline and PR the run produced', async () => {
    const { sink, delivered } = recordingSink()
    await makeMachine(task, sink).emitInstance('ws_1', makeInstance({ status: 'done' }))

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toEqual({
      event: 'run.completed',
      runId: 'exec_1',
      taskId: 'task_login',
      taskTitle: 'Add passkey login',
      pipelineId: 'pl_full',
      pipelineName: 'Full',
      startedAt: 1_699_000_000_000,
      occurredAt: 1_700_000_000_000,
      pullRequestUrl: 'https://vcs.test/pr/7',
      failure: null,
    })
  })

  it('pushes run.failed carrying the run failure record', async () => {
    const { sink, delivered } = recordingSink()
    await makeMachine(task, sink).emitInstance(
      'ws_1',
      makeInstance({
        status: 'failed',
        failure: {
          kind: 'environment',
          message: 'runner unwired',
          reason: 'deploy_runner_unwired',
        } as ExecutionInstance['failure'],
      }),
    )

    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.event).toBe('run.failed')
    expect(delivered[0]!.failure).toEqual({
      kind: 'environment',
      message: 'runner unwired',
      reason: 'deploy_runner_unwired',
    })
  })

  it('pushes nothing on a non-terminal emit', async () => {
    // The engine emits on every container poll; a per-emit push would be a firehose, which is
    // what the SSE endpoints are for.
    const { sink, delivered } = recordingSink()
    const machine = makeMachine(task, sink)
    await machine.emitInstance('ws_1', makeInstance({ status: 'running' }))
    await machine.emitInstance('ws_1', makeInstance({ status: 'blocked' }))
    expect(delivered).toHaveLength(0)
  })

  it('suppresses the push for a headless internal anchor block', async () => {
    // The public API's own run: its "task" is not a board task and its title is the caller's
    // brief, so there is nothing a receiver could do with it that GET /api/v1/jobs/:id does not
    // already serve. Suppressed for the same reason the live push is.
    const { sink, delivered } = recordingSink()
    await makeMachine(internalAnchor, sink).emitInstance('ws_1', makeInstance({ status: 'done' }))
    expect(delivered).toHaveLength(0)
  })

  it('is a no-op when no sink is wired', async () => {
    await expect(
      makeMachine(task).emitInstance('ws_1', makeInstance({ status: 'done' })),
    ).resolves.toBeUndefined()
  })

  it('scrubs secrets out of the failure prose before it leaves the deployment', async () => {
    // The failure message is engine-authored but routinely quotes a provider error or a command's
    // stderr, and this projection is the one that reaches an OPERATOR-supplied endpoint. `detail`
    // (the verbatim half) is not projected at all; what is gets the same scrub every other
    // captured-output field takes at its emit site.
    const { sink, delivered } = recordingSink()
    await makeMachine(task, sink).emitInstance(
      'ws_1',
      makeInstance({
        status: 'failed',
        failure: {
          kind: 'agent',
          message: 'push rejected for https://user:ghp_0123456789abcdefghijklmnopqrstuvwxyz@host/r',
          reason: null,
        } as ExecutionInstance['failure'],
      }),
    )

    expect(delivered[0]!.failure!.message).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyz')
  })

  it('publishes run.started from the block it is HANDED, making no read of its own', async () => {
    // The hand-off funnel already holds the block; re-reading it here would be an extra round
    // trip per run start — a NETWORK one on a mothership deployment. A repository that throws
    // proves the read is gone rather than merely redundant.
    const { sink, delivered } = recordingSink()
    const machine = new RunStateMachine({
      executionRepository: {} as never,
      blockRepository: {
        get: async () => {
          throw new Error('blockRepository must not be read on the start path')
        },
      } as unknown as BlockRepository,
      events: { executionChanged: async () => {} } as unknown as ExecutionEventPublisher,
      workRunner: {} as never,
      agentExecutor: {} as never,
      idGenerator: {} as never,
      clock: { now: () => 1_700_000_000_000 },
      stepGraph: {} as never,
      runLifecycleSink: sink,
    })

    await machine.publishRunStarted('ws_1', makeInstance(), task)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.event).toBe('run.started')
    expect(delivered[0]!.taskTitle).toBe('Add passkey login')
  })

  it('a sink that breaks its no-throw contract cannot strand the terminal cleanup', async () => {
    // The push is the only terminal hook that leaves the deployment, so it runs LAST and behind
    // `runBestEffort`. Without both, a third-party sink that throws would take the per-run
    // credential-activation delete with it — a lingering system-encrypted token copy, which is a
    // worse outcome than a dropped webhook. The drop is reported, never silent.
    const cleared: string[] = []
    const logger = createRecordingLogger()
    const machine = makeMachine(
      task,
      {
        runTransitioned: async () => {
          throw new Error('receiver exploded')
        },
      },
      {
        subscriptionActivations: {
          deleteByExecution: async (id: string) => {
            cleared.push(id)
          },
        } as unknown as SubscriptionActivationRepository,
        logger,
      },
    )

    await expect(
      machine.emitInstance('ws_1', makeInstance({ status: 'done' })),
    ).resolves.toBeUndefined()
    expect(cleared).toEqual(['exec_1'])
    expect(
      logger.lines.some((l) => l.level === 'warn' && l.msg.includes('publishRunLifecycle')),
    ).toBe(true)
  })

  it('reports a terminal run whose block vanished rather than dropping the event', async () => {
    // A delete racing the settle still yields a usable event: the ids are what a receiver routes
    // on, and an empty title is honest about what could be read.
    const { sink, delivered } = recordingSink()
    await makeMachine(null, sink).emitInstance('ws_1', makeInstance({ status: 'done' }))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.taskTitle).toBe('')
    expect(delivered[0]!.pullRequestUrl).toBeNull()
  })
})
