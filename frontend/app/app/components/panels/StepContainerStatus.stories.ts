import type { Meta, StoryObj } from '@storybook/vue3'
import { step } from '~/stories/pipelineStep.stories.mocks'
import StepContainerStatus from './StepContainerStatus.vue'

// The container behind a container-backed step: whether it is starting, up, errored or gone, what
// it is doing while up, and its id and address with copy buttons. Shared by the step detail and the
// tester window. A container step that has finished, or whose run failed, reads as destroyed
// whatever was stored, because the run's container is reclaimed with the run. The id and address
// are made up: their form depends on the runner.
const container = {
  status: 'up' as const,
  phase: 'agent',
  id: 'job-7f3c9a2e',
  url: 'http://localhost:43117',
}

const meta = {
  title: 'Pipeline/Components/StepContainerStatus',
  component: StepContainerStatus,
  parameters: { width: 'panel' },
  args: { step: step({ container }), runFailed: false, runActive: true },
} satisfies Meta<typeof StepContainerStatus>
export default meta

type Story = StoryObj<typeof meta>

/** Up, with the agent at work, its id and its address. */
export const Default: Story = {}

/** Spinning up: the icon turns while the run is driven, and there is no id or address yet. */
export const Starting: Story = {
  args: { step: step({ container: { status: 'starting' } }) },
}

/** The container errored, in the error tone. */
export const Errored: Story = {
  args: { step: step({ container: { ...container, status: 'errored' } }) },
}

/** The step finished, so its container is gone. */
export const Destroyed: Story = {
  args: { step: step({ state: 'done', progress: 1, container }) },
}
