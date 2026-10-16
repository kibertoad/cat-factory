import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import { seedUiMode, withSeed } from '~/stories/withStores'
import { useLaneViewStore } from '~/stores/laneView'
import LaneViewControl from './LaneViewControl.vue'

// The toolbar menu that overrides how every frame's swimlanes are sorted and grouped. It is an
// advanced tier control, but it stays in the basic tier while an override is set, so the user can
// still find and clear it. The menu opens on click, and the wrapper leaves room below for it.
const meta = {
  title: 'Board/Components/LaneViewControl',
  component: LaneViewControl,
  decorators: [withSeed(() => seedUiMode('advanced'))],
  render: () => ({
    components: { LaneViewControl },
    template: '<div class="pb-112"><LaneViewControl /></div>',
  }),
} satisfies Meta<typeof LaneViewControl>
export default meta

type Story = StoryObj<typeof meta>

async function openMenu(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByTestId('lane-view-control'))
}

/** No override: a plain Arrange button. */
export const Default: Story = {}

/** The sort and group sections, with a check on Recommended per lane and on No grouping. */
export const Open: Story = {
  play: async ({ canvasElement }) => openMenu(canvasElement),
}

/**
 * Longest waiting, grouped by module: the button is tinted, and the menu ends with Reset to
 * defaults.
 */
export const Overridden: Story = {
  decorators: [
    withSeed(() => {
      const laneView = useLaneViewStore()
      laneView.setSortKey('longest_wait')
      laneView.setGroupKey('module')
    }),
  ],
  play: async ({ canvasElement }) => openMenu(canvasElement),
}

/**
 * The basic tier with an override set: the control stays, so the override can be found and
 * reset. With no override the basic tier shows nothing here.
 */
export const BasicWithOverride: Story = {
  decorators: [
    withSeed(() => {
      seedUiMode('basic')
      useLaneViewStore().setGroupKey('epic')
    }),
  ],
}
