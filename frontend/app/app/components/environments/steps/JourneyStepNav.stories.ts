import type { Meta, StoryObj } from '@storybook/vue3'
import UButton from '@nuxt/ui/components/Button.vue'
import JourneyStepNav from './JourneyStepNav.vue'

// The footer of a setup journey step: Back on the left, the step's own action in the `primary`
// slot on the right. With no `goBack` (the first step, or back not allowed) Back is disabled.
// `UButton` is imported because a template string does not get Nuxt's auto-imports.
const meta = {
  title: 'Setup/Components/JourneyStepNav',
  component: JourneyStepNav,
  parameters: { width: 'prose' },
  render: (args) => ({
    components: { JourneyStepNav, UButton },
    setup: () => ({ args }),
    template:
      '<JourneyStepNav v-bind="args"><template #primary><UButton color="primary">Continue</UButton></template></JourneyStepNav>',
  }),
} satisfies Meta<typeof JourneyStepNav>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: { goBack: () => {} } }

/** The first step: Back is disabled. */
export const FirstStep: Story = { args: { goBack: undefined } }

/** No primary slot. */
export const BackOnly: Story = {
  args: { goBack: () => {} },
  render: (args) => ({
    components: { JourneyStepNav },
    setup: () => ({ args }),
    template: '<JourneyStepNav v-bind="args" />',
  }),
}
