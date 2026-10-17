import type { Meta, StoryObj } from '@storybook/vue3'
import { step } from '~/stories/pipelineStep.stories.mocks'
import StepRunMeta from './StepRunMeta.vue'

// The run facts every step-backed result window shows in its sidebar: the step's position, how
// long it took, when it started and finished, the model, a prompt variant when one ran, and the
// run id. The model shows the model part of its ref: the label comes from the models catalog,
// which these stories do not load.
const startedAt = Date.UTC(2026, 9, 11, 9, 30)

const meta = {
  title: 'Pipeline/Components/StepRunMeta',
  component: StepRunMeta,
  parameters: { width: 'narrow' },
  args: {
    step: step({
      agentKind: 'coder',
      state: 'done',
      progress: 1,
      startedAt,
      finishedAt: startedAt + 14 * 60_000 + 32_000,
      model: 'workers-ai:@cf/zai-org/glm-5.2',
      runId: 'exec_login',
    }),
    stepNumber: 2,
    totalSteps: 3,
  },
} satisfies Meta<typeof StepRunMeta>
export default meta

type Story = StoryObj<typeof meta>

/** A finished step: step 2 of 3, 14m 32s, its start and finish, the model and the run id. */
export const Default: Story = {}

/**
 * A step still working: the clock runs, and the last activity line says how long ago the agent
 * last did something. Both count from the time the story renders, so the figures move.
 */
export const Running: Story = {
  args: {
    step: step({
      agentKind: 'coder',
      startedAt: Date.now() - 6 * 60_000,
      lastActivityAt: Date.now() - 20_000,
      model: 'workers-ai:@cf/zai-org/glm-5.2',
      runId: 'exec_login',
    }),
  },
}

/** The run failed mid-step: the clock stops at the failure, and there is no finish time. */
export const FailedRun: Story = {
  args: {
    step: step({
      agentKind: 'coder',
      startedAt,
      model: 'workers-ai:@cf/zai-org/glm-5.2',
      runId: 'exec_login',
    }),
    runFailed: true,
    failureAt: startedAt + 3 * 60_000 + 5_000,
  },
}
