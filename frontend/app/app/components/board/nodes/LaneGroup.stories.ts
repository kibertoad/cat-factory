import type { Meta, StoryObj } from '@storybook/vue3'
import { computed } from 'vue'
import { useFrameLanes } from '~/composables/useFrameLanes'
import { authService, sessionsModule } from '~/stories/board.stories.mocks'
import { boardApi } from '~/stories/boardApi'
import { laneSnapshot } from '~/stories/lanes.stories.mocks'
import { seedLaneView, seedSnapshot, withSeed } from '~/stories/withStores'
import { useLaneViewStore } from '~/stores/laneView'
import type { LaneGroupKey } from '~/utils/laneSort'
import LaneGroup from './LaneGroup.vue'

// One labelled run of cards inside Auth Service's Needs you lane. The lane hands each group to
// this component as the frame assembles it (`useFrameLanes`), so the story assembles the lane
// board (`lanes.stories.mocks.ts`) the same way and passes the group it names: a module group by
// its block id, the catch-all by null. Grouping is the board-wide choice in the lane view store,
// so each story sets it.
interface LaneGroupArgs {
  /** The group's id: a module's block id when grouping by module, null for the catch-all. */
  groupId: string | null
  layout: 'column' | 'grid'
}

function arranged(groupKey: LaneGroupKey) {
  return withSeed(() => {
    seedSnapshot(laneSnapshot())
    seedLaneView(groupKey)
  })
}

const meta = {
  title: 'Board/Components/LaneGroup',
  render: (args) => ({
    components: { LaneGroup },
    setup() {
      const laneView = useLaneViewStore()
      const { lanes } = useFrameLanes(computed(() => authService.id))
      const group = computed(() =>
        lanes.value.find((l) => l.lane === 'needs_you')!.groups.find((g) => g.id === args.groupId)!,
      )
      return { args, laneView, group, frameId: authService.id }
    },
    template:
      '<LaneGroup :group="group" :group-key="laneView.groupKey" :frame-id="frameId" ' +
      ':layout="args.layout" />',
  }),
  args: { groupId: sessionsModule.id, layout: 'column' },
  parameters: { api: boardApi(laneSnapshot().blocks) },
} satisfies Meta<LaneGroupArgs>
export default meta

type Story = StoryObj<typeof meta>

/** Grouped by module: the Sessions header, a drop zone into the module, and its two cards. */
export const Default: Story = {
  parameters: { width: 'narrow' },
  decorators: [arranged('module')],
}

/** The catch-all for the tasks in no module: its header says so, and a drop there leaves one. */
export const CatchAll: Story = {
  args: { groupId: null },
  parameters: { width: 'narrow' },
  decorators: [arranged('module')],
}

/** No grouping: the whole lane is one group, with no header. */
export const Ungrouped: Story = {
  args: { groupId: null },
  parameters: { width: 'narrow' },
  decorators: [arranged('none')],
}

/** The same cards laid out as the opened Done strip lays them: wrapped across the width. */
export const Grid: Story = {
  args: { groupId: null, layout: 'grid' },
  decorators: [arranged('none')],
}
