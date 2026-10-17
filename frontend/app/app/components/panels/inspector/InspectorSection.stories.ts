import type { Meta, StoryObj } from '@storybook/vue3'
import InspectorSection from './InspectorSection.vue'

// The collapsible section the inspector is built from. The header is a `SectionLabel` with an
// optional icon, count and warning icon; the hint opens at the top of the body. It starts closed
// unless `defaultOpen` is set.
const body = '<p class="text-sm text-muted">Three steps ran. None of them wrote a file.</p>'

const meta = {
  title: 'Inspector/Components/InspectorSection',
  component: InspectorSection,
  parameters: { width: 'panel' },
  render: (args) => ({
    components: { InspectorSection },
    setup: () => ({ args }),
    template: `<InspectorSection v-bind="args">${body}</InspectorSection>`,
  }),
  args: { title: 'Steps' },
} satisfies Meta<typeof InspectorSection>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: {} }

export const Open: Story = { args: { defaultOpen: true } }

export const WithCount: Story = {
  args: { count: 3, icon: 'i-lucide-list-checks', defaultOpen: true },
}

/** A hint, which says what the section is for. */
export const WithHint: Story = {
  args: { hint: 'Only the steps that produced output.', defaultOpen: true },
}

/** The warning flag: a warning icon after the count. */
export const Warning: Story = { args: { warning: true, count: 2, defaultOpen: true } }
