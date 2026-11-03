import type { Meta, StoryObj } from '@storybook/vue3'
import SectionLabel from './SectionLabel.vue'

// The small uppercase label that titles a group (#2248). Its colour is `text-muted`, not
// `text-dimmed`, because at this size `text-dimmed` is 2.63:1 on a light surface. `as` changes
// the element, never the look, so there is no story for it.
const meta = {
  title: 'Primitives/Components/SectionLabel',
  component: SectionLabel,
  render: (args) => ({
    components: { SectionLabel },
    setup: () => ({ args }),
    template: '<SectionLabel v-bind="args">Recent activity</SectionLabel>',
  }),
} satisfies Meta<typeof SectionLabel>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: {} }

/** Above the body text it titles. */
export const InContext: Story = {
  render: () => ({
    components: { SectionLabel },
    template: `
      <div class="max-w-sm space-y-2">
        <SectionLabel class="mb-2">Recent activity</SectionLabel>
        <p class="text-sm">Three runs finished in the last hour.</p>
      </div>
    `,
  }),
}
