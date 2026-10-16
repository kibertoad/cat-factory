import type { Meta, StoryObj } from '@storybook/vue3'
import { fn, screen, userEvent, within } from 'storybook/test'
import { manualReviewPolicy, riskPolicy } from '~/stories/policies.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useWorkspaceStore } from '~/stores/workspace'
import RiskPolicyPicker from './RiskPolicyPicker.vue'

// The merge policy picker of a task: a button that opens a list of policy names, with what the
// pointed (or chosen) policy does on the right. The first row is the workspace default. A row
// that would relax what the person's own role is held to is locked, and pointing at it says why.
// The library is the three built-ins.
//
// Opening the list moves focus to the default row, and a focused row drives the preview, so the
// pane opens on the workspace default rather than on the chosen policy.
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
    noneLabel: '',
    'onUpdate:modelValue': fn(),
  },
  render: (args) => ({
    components: { RiskPolicyPicker },
    setup() {
      const { t } = useI18n()
      const noneLabel = t('inspector.runSettings.defaultRiskPolicy', { name: balanced.name })
      return { args, noneLabel }
    },
    template: '<div class="pb-96"><RiskPolicyPicker v-bind="args" :none-label="noneLabel" /></div>',
  }),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('risk-policy-picker-trigger'))
  },
} satisfies Meta<typeof RiskPolicyPicker>
export default meta

type Story = StoryObj<typeof meta>

/** Manual review only chosen: its check in the list, and the default's preview on the right. */
export const Default: Story = {}

/** No policy chosen: the default row is checked, and the preview says it comes from the default. */
export const WorkspaceDefault: Story = { args: { modelValue: '' } }

/**
 * A member on a Balanced task points at Unattended delivery: the row is locked, because it would
 * drop the run's checkpoints, and the pane says so.
 */
export const Refused: Story = {
  args: { modelValue: balanced.id },
  decorators: [
    withSeed(() => {
      useWorkspaceStore().access = {
        role: 'member',
        permissions: ['workspace.read', 'board.write', 'runs.execute'],
      }
    }),
  ],
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('risk-policy-picker-trigger'))
    await userEvent.hover(await screen.findByTestId('risk-policy-option-mp_unattended'))
  },
}

/** Closed: the button with the chosen policy's name. */
export const Closed: Story = { play: async () => {} }
