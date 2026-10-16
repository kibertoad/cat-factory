import type { Meta, StoryObj } from '@storybook/vue3'
import type {
  CustomAgentKind,
  ExecutionInstance,
  Pipeline,
  RalphAttempt,
  RalphStepState,
} from '@cat-factory/contracts'
import { block } from '~/stories/block.stories.mocks'
import { boardBlocks } from '~/stories/board.stories.mocks'
import { step } from '~/stories/pipelineStep.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import type { Block } from '~/types/domain'
import RalphLoopResultView from './RalphLoopResultView.vue'

// The Ralph loop's window: the validation command that decides when the loop is done, the latest
// validation output, and every iteration, newest first, with what it changed. From the lg width
// a sidebar also gives the state and the count against the budget; the captures are narrower,
// so it does not show in them. The window reads the run straight off the
// execution store, so each story seeds the run whole and opens the window on its Ralph step. The
// pipeline is a copy of the backend's `pl_ralph` (`seed.ts` in kernel), and the history keeps at
// most 20 iterations (`MAX_RALPH_ATTEMPT_LOG` in orchestration). The task and its test output are
// made up.
const meta = {
  title: 'Run telemetry/Components/RalphLoopResultView',
  component: RalphLoopResultView,
} satisfies Meta<typeof RalphLoopResultView>
export default meta

type Story = StoryObj<typeof meta>

const ralphPipeline: Pipeline = {
  id: 'pl_ralph',
  name: 'Ralph loop',
  purpose: 'build',
  agentKinds: ['ralph', 'conflicts', 'ci', 'merger'],
}

/**
 * The Ralph kind as the snapshot projects it (`snapshotCustomAgentKinds` in server, from the
 * registration in `kinds/ralph.ts`): the SPA's own catalog has no entry for it, so its name, icon
 * and colour come from here.
 */
const ralphKind: CustomAgentKind = {
  kind: 'ralph',
  container: true,
  executor: 'container',
  presentation: {
    label: 'Ralph Loop',
    icon: 'i-lucide-repeat',
    color: '#8b5cf6',
    description:
      'Persistently re-runs a fresh-context coding iteration until the task’s configured ' +
      'validation command passes (or the iteration budget is spent).',
    category: 'build',
    tier: 'advanced',
    resultView: 'ralph-loop',
  },
}

const ralphTask: Block = block({
  id: 'task_flaky_expiry',
  title: 'Fix the flaky session expiry tests',
  parentId: 'svc_auth',
  taskType: 'ralph',
  pipelineId: ralphPipeline.id,
  executionId: 'exec_flaky_expiry',
})

const COMMAND = 'pnpm vitest run src/session --retry=0'
const START = Date.UTC(2026, 9, 11, 13, 0)

const failingTail =
  'FAIL  src/session/expiry.spec.ts > expiry > drops a session one second after it expires\n' +
  'AssertionError: expected true to be false\n' +
  '\n' +
  'Test Files  1 failed | 5 passed (6)\n' +
  '     Tests  1 failed | 41 passed (42)'

/** Iteration `n`, eight minutes apart; failed with exit 1 unless `passed`. */
function iteration(n: number, summary: string, passed = false): RalphAttempt {
  return {
    attempt: n,
    at: START + n * 8 * 60_000,
    validationPassed: passed,
    exitCode: passed ? 0 : 1,
    outputTail: passed ? 'Test Files  6 passed (6)' : failingTail,
    summary,
    headSha: null,
  }
}

const first = iteration(1, 'Pinned the clock in the expiry tests with vi.useFakeTimers().')
const second = iteration(
  2,
  'The expiry check read Date.now() directly; it now reads the injected clock.',
)
const third = iteration(3, 'Awaited the session store flush before the assertion.', true)

function loop(overrides: Partial<RalphStepState> = {}): RalphStepState {
  return {
    phase: 'iterating',
    attempts: 2,
    maxIterations: 10,
    validationCommand: COMMAND,
    lastExitCode: 1,
    lastValidationTail: failingTail,
    attemptLog: [first, second],
    droppedAttempts: 0,
    ...overrides,
  }
}

/**
 * The loop's run, with the Ralph step in `ralphStep`. The step at `currentStep` works and the
 * steps after it are pending.
 */
function run(
  ralphStep: ReturnType<typeof step>,
  status: ExecutionInstance['status'] = 'running',
  currentStep = 0,
): ExecutionInstance {
  const tail = (['conflicts', 'ci', 'merger'] as const).map((agentKind, i) =>
    step({ agentKind, state: i + 1 === currentStep ? 'working' : 'pending', progress: 0 }),
  )
  return {
    id: 'exec_flaky_expiry',
    blockId: ralphTask.id,
    pipelineId: ralphPipeline.id,
    pipelineName: ralphPipeline.name,
    steps: [ralphStep, ...tail],
    currentStep,
    status,
  }
}

function withLoop(instance: ExecutionInstance, task: Block = ralphTask) {
  return withSeed(() => {
    seedSnapshot(
      snapshot({
        blocks: [...boardBlocks, task],
        pipelines: [ralphPipeline],
        executions: [instance],
        customAgentKinds: [ralphKind],
      }),
    )
    seedResultView({
      view: 'ralph-loop',
      blockId: task.id,
      instanceId: instance.id,
      stepIndex: 0,
    })
  })
}

/**
 * Iteration 3 is running: the command, the second iteration's failing output (exit 1), and both
 * iterations so far, of a budget of 10.
 */
export const Default: Story = {
  decorators: [
    withLoop(
      run(
        step({
          agentKind: 'ralph',
          state: 'working',
          progress: 0.2,
          ralph: loop(),
          container: { status: 'up' },
        }),
      ),
    ),
  ],
}

/**
 * The step has not dispatched yet, so there is no loop state: the empty state. The badge still
 * says Failing, because a step with no container is read as between
 * two failed iterations.
 */
export const Empty: Story = {
  decorators: [withLoop(run(step({ agentKind: 'ralph', state: 'pending', progress: 0 })))],
}

/**
 * Iteration 3 passed: exit 0, all three iterations, and the link to the pull request. The run
 * moved on to its conflicts gate.
 */
export const Passed: Story = {
  decorators: [
    withLoop(
      run(
        step({
          agentKind: 'ralph',
          state: 'done',
          progress: 1,
          ralph: loop({
            attempts: 3,
            lastExitCode: 0,
            lastValidationTail: 'Test Files  6 passed (6)\n     Tests  42 passed (42)',
            attemptLog: [first, second, third],
          }),
        }),
        'running',
        1,
      ),
      {
        ...ralphTask,
        pullRequest: {
          url: 'https://github.com/acme/auth-service/pull/61',
          number: 61,
          branch: 'cat-factory/flaky-session-expiry',
        },
      },
    ),
  ],
}

/**
 * The run failed at 3 of 10: the last two iterations left the branch as it was, which is the
 * engine's limit (`RALPH_NO_PROGRESS_LIMIT` in orchestration), so the loop stopped early, and a
 * note says the task or the command needs a change. A failed loop leaves its step un-done.
 */
export const Stalled: Story = {
  decorators: [
    withLoop(
      run(
        step({
          agentKind: 'ralph',
          state: 'working',
          progress: 0.3,
          ralph: loop({
            attempts: 3,
            noProgressStreak: 2,
            attemptLog: [
              first,
              iteration(2, 'No change: the expiry test already pins the clock.'),
              iteration(3, 'No change: the clock was already injected.'),
            ],
          }),
        }),
        'failed',
      ),
    ),
  ],
}

/** The run failed with the whole budget of 10 spent: Gave up, and no note. */
export const GaveUp: Story = {
  decorators: [
    withLoop(
      run(
        step({
          agentKind: 'ralph',
          state: 'working',
          progress: 1,
          ralph: loop({
            attempts: 10,
            attemptLog: Array.from({ length: 10 }, (_, i) =>
              iteration(
                i + 1,
                i % 2 ? 'Retried with a longer settle delay.' : 'Re-pinned the clock.',
              ),
            ),
          }),
        }),
        'failed',
      ),
    ),
  ],
}

/**
 * A long loop at 34 of 40: the window keeps the latest 20 iterations, and a line says 14 earlier
 * ones are not shown.
 */
export const DroppedHistory: Story = {
  decorators: [
    withLoop(
      run(
        step({
          agentKind: 'ralph',
          state: 'working',
          progress: 0.85,
          ralph: loop({
            attempts: 34,
            maxIterations: 40,
            droppedAttempts: 14,
            attemptLog: Array.from({ length: 20 }, (_, i) =>
              iteration(i + 15, 'Narrowed the expiry window by one tick.'),
            ),
          }),
          container: { status: 'up' },
        }),
      ),
    ),
  ],
}
