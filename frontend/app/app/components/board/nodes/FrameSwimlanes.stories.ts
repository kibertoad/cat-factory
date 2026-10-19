import type { Meta, StoryObj } from '@storybook/vue3'
import { authService, boardWith, loginTask } from '~/stories/board.stories.mocks'
import { boardApi } from '~/stories/boardApi'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedLaneView, seedSnapshot, withSeed } from '~/stories/withStores'
import FrameSwimlanes from './FrameSwimlanes.vue'

// A service's tasks in status lanes: three live lanes side by side, and Done as a strip beneath.
// The lanes are derived from the stores, so the story fills them from one workspace snapshot.
const blocks = boardWith({ ...loginTask, executionId: 'exec_login' })

const meta = {
  title: 'Board/Components/FrameSwimlanes',
  component: FrameSwimlanes,
  // A dragged card sends a write, which `boardApi` answers from memory.
  parameters: { api: boardApi(blocks) },
  decorators: [
    withSeed(() => {
      seedSnapshot(snapshot({ blocks, executions: [execution()] }))
      seedLaneView()
    }),
  ],
} satisfies Meta<typeof FrameSwimlanes>
export default meta

type Story = StoryObj<typeof meta>

/** Auth Service: a planned task, one in progress, one merged. */
export const Default: Story = { args: { frameId: authService.id, laneBodyHeight: 360 } }
