import type { Meta, StoryObj } from '@storybook/vue3'
import { boardBlocks } from '~/stories/board.stories.mocks'
import { seedBoard, withSeed } from '~/stories/withStores'
import EnvPickStep from './EnvPickStep.vue'

// The first step of the environment setup wizard: pick the service whose test environment to
// set up. It lists the board's top-level service frames, and a click ends the step with that
// frame. The wizard's journey renders the step and passes `exit`; here it does nothing.
const meta = {
  title: 'Setup/Components/EnvPickStep',
  component: EnvPickStep,
  args: { input: { frameId: null }, exit: () => {} },
  parameters: { width: 'prose' },
  decorators: [withSeed(() => seedBoard(boardBlocks))],
} satisfies Meta<typeof EnvPickStep>
export default meta

type Story = StoryObj<typeof meta>

/** The shared board's two services. */
export const Default: Story = {}

/** No service on the board yet. */
export const Empty: Story = { decorators: [withSeed(() => seedBoard([]))] }
