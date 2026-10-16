import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import { block } from '~/stories/block.stories.mocks'
import ResizeGrips from './ResizeGrips.vue'

// The eight resize grips around a frame or a module. At rest only the bottom-right corner shows;
// the edge under the pointer lights up. A frame's grips use the info colour, a module's the
// secondary colour. A viewer who cannot write to the board gets no grips.
const meta = {
  title: 'Board/Components/ResizeGrips',
  component: ResizeGrips,
  render: (args) => ({
    components: { ResizeGrips },
    setup: () => ({ args }),
    template:
      '<div class="relative h-48 w-80 rounded-xl border border-default bg-elevated/40"><ResizeGrips v-bind="args" /></div>',
  }),
} satisfies Meta<typeof ResizeGrips>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { block: block({ level: 'frame', type: 'service' }), tone: 'frame' },
}

/** A module inside a frame. Violet, so the two are never confused mid-drag. */
export const Module: Story = {
  args: { block: block({ level: 'module', type: 'service' }), tone: 'module' },
}

/** The pointer on the right edge of a frame: that bar lights up. */
export const HoverEdge: Story = {
  args: { block: block({ level: 'frame', type: 'service' }), tone: 'frame' },
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByTestId('resize-e'))
  },
}

/** The pointer on a module's top-left corner: the corner mark lights up. */
export const HoverCorner: Story = {
  args: { block: block({ level: 'module', type: 'service' }), tone: 'module' },
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByTestId('resize-nw'))
  },
}
