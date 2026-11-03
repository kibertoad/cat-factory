import type { Meta, StoryObj } from '@storybook/vue3'
import { computed } from 'vue'
import { useFrameLanes } from '~/composables/useFrameLanes'
import { authService } from '~/stories/board.stories.mocks'
import { boardApi } from '~/stories/boardApi'
import { laneSnapshot } from '~/stories/lanes.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedLaneView, seedSnapshot, withSeed } from '~/stories/withStores'
import { useLaneViewStore } from '~/stores/laneView'
import type { LaneGroupKey } from '~/utils/laneSort'
import type { TaskLane as Lane } from '~/utils/swimlanes'
import TaskLane from './TaskLane.vue'

// One status lane of Auth Service: a header with its count, and a body that scrolls. The lane
// takes its cards as the frame assembles them (`useFrameLanes`), so the story assembles them the
// same way from the lane board (`lanes.stories.mocks.ts`) and passes the lane it names. Grouping
// is the board-wide choice in the lane view store, so each story sets it.
interface TaskLaneArgs {
  lane: Lane
  bodyHeight: number
}

function arranged(groupKey: LaneGroupKey, next = laneSnapshot()) {
  return withSeed(() => {
    seedSnapshot(next)
    seedLaneView(groupKey)
  })
}

const meta = {
  title: 'Board/Components/TaskLane',
  render: (args) => ({
    components: { TaskLane },
    setup() {
      const laneView = useLaneViewStore()
      const { lanes } = useFrameLanes(computed(() => authService.id))
      const rendered = computed(() => lanes.value.find((l) => l.lane === args.lane)!)
      return { args, laneView, rendered, frameId: authService.id }
    },
    template:
      '<TaskLane :rendered="rendered" :group-key="laneView.groupKey" :frame-id="frameId" ' +
      ':body-height="args.bodyHeight" />',
  }),
  args: { lane: 'in_progress', bodyHeight: 360 },
  // A dragged card sends a write, which `boardApi` answers from memory.
  parameters: { api: boardApi(laneSnapshot().blocks) },
} satisfies Meta<TaskLaneArgs>
export default meta

type Story = StoryObj<typeof meta>

/** In progress: the login task's run, at the coder step. */
export const Default: Story = {
  decorators: [arranged('none')],
}

/** Nothing in the lane: it says so, in place of the cards. */
export const Empty: Story = {
  args: { lane: 'needs_you' },
  decorators: [arranged('none', snapshot())],
}

/** Needs you: a pull request to merge, a plan to approve and a question to answer. */
export const NeedsYou: Story = {
  args: { lane: 'needs_you' },
  decorators: [arranged('none')],
}

/** The same lane grouped by module: the Sessions group, and the catch-all for the service. */
export const Grouped: Story = {
  args: { lane: 'needs_you' },
  decorators: [arranged('module')],
}
