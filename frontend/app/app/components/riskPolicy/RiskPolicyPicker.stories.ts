import type { Meta, StoryObj } from '@storybook/vue3'
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test'
import { manualReviewPolicy, riskPolicy } from '~/stories/policies.stories.mocks'
import { seedMember, withSeed } from '~/stories/withStores'
import RiskPolicyPicker from './RiskPolicyPicker.vue'

// The merge policy picker of a task: a button that opens a list of policy names, with what the
// pointed (or chosen) policy does on the right. The first row is the workspace default. A row
// that would relax what the person's own role is held to is locked, and pointing at it says why.
// The library is the three built-ins.
//
// Opening the list moves focus to the chosen row, and a focused row drives the preview, so the
// pane opens on the chosen policy.
const balanced = riskPolicy()
const unattended = riskPolicy({
  id: 'mp_unattended',
  name: 'Unattended delivery',
  autonomy: 'unattended',
  isDefault: false,
  isUnattendedDefault: true,
  version: 1,
})

const meta = {
  title: 'Inspector/Components/RiskPolicyPicker',
  component: RiskPolicyPicker,
  args: {
    modelValue: manualReviewPolicy.id,
    options: [balanced, manualReviewPolicy, unattended],
    defaultPolicy: balanced,
    // The inspector's `Default ({name})` row label, as English text so Controls can edit it.
    noneLabel: `Default (${balanced.name})`,
    'onUpdate:modelValue': fn(),
  },
  render: (args) => ({
    components: { RiskPolicyPicker },
    setup: () => ({ args }),
    template: '<div class="pb-96"><RiskPolicyPicker v-bind="args" /></div>',
  }),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('risk-policy-picker-trigger'))
    // The list is teleported to `body`; focus and the pane open on the chosen policy.
    const chosen = await screen.findByTestId(`risk-policy-option-${manualReviewPolicy.id}`)
    await waitFor(() => expect(chosen).toHaveFocus())
    await expect(
      screen.queryByText('Applied because this task picks no policy of its own.'),
    ).toBeNull()
  },
} satisfies Meta<typeof RiskPolicyPicker>
export default meta

type Story = StoryObj<typeof meta>

/** Manual review only chosen: its check in the list, and its preview on the right. */
export const Default: Story = {}

/** No policy chosen: the default row is checked, and the preview says it comes from the default. */
export const WorkspaceDefault: Story = {
  args: { modelValue: '' },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('risk-policy-picker-trigger'))
    await screen.findByText('Applied because this task picks no policy of its own.')
  },
}

/**
 * A member on a Balanced task points at Unattended delivery: the row is locked, because it would
 * drop the run's checkpoints, and the pane says so.
 */
export const Refused: Story = {
  args: { modelValue: balanced.id },
  decorators: [withSeed(seedMember)],
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('risk-policy-picker-trigger'))
    await userEvent.hover(await screen.findByTestId('risk-policy-option-mp_unattended'))
    await screen.findByTestId('risk-policy-refusal')
  },
}

/** Closed: the button with the chosen policy's name. */
export const Closed: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText('Manual review only')
  },
}
