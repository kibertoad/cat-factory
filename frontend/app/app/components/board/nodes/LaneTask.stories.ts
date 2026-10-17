import type { Meta, StoryObj } from '@storybook/vue3'
import { loginTask } from '~/stories/board.stories.mocks'
import { boardApi } from '~/stories/boardApi'
import { laneSnapshot } from '~/stories/lanes.stories.mocks'
import { seedSnapshot, seedViewer, withSeed } from '~/stories/withStores'
import LaneTask from './LaneTask.vue'

// One card in a swimlane: the task card under a grip that drags it to another service or module.
// The card has no position, so the drag only moves it to a new parent. The story fills the stores
// from the lane board (`lanes.stories.mocks.ts`).
const meta = {
  title: 'Board/Components/LaneTask',
  component: LaneTask,
  args: { taskId: loginTask.id },
  parameters: { width: 'narrow', api: boardApi(laneSnapshot().blocks) },
} satisfies Meta<typeof LaneTask>
export default meta

type Story = StoryObj<typeof meta>

/** The login task's run, under the grip. */
export const Default: Story = {
  decorators: [withSeed(() => seedSnapshot(laneSnapshot()))],
}

/** A board viewer cannot drag, so there is no grip and the card keeps its round top. */
export const ReadOnly: Story = {
  decorators: [
    withSeed(() => {
      seedSnapshot(laneSnapshot())
      seedViewer()
    }),
  ],
}
