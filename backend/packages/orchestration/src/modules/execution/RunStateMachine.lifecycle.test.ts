import type {
  Block,
  BlockRepository,
  ExecutionEventPublisher,
  ExecutionInstance,
  RunLifecycleEvent,
  RunLifecycleSink,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { RunStateMachine } from './RunStateMachine.js'

// The outbound run-lifecycle push rides the terminal-emit funnel — the same place the Kaizen
// scheduler and the activation cleanup hook — because a run reaches `done` from four independent
// sites and a hook at each would silently drift. These pin what that choice has to guarantee: only
// the TERMINAL edges push, the failure record rides `run.failed`, the headless internal anchor is
// suppressed exactly as the live push is, and an unwired sink changes nothing.

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

function makeMachine(block: Block | null, sink?: RunLifecycleSink) {
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
