import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import type { PipelinePurpose } from '@cat-factory/contracts'
import PipelinePurposeSelect from './PipelinePurposeSelect.vue'

// What the pipeline being built is for, in the builder's palette. It narrows the agent catalog
// below it, is saved on the pipeline, and decides which task pickers offer the pipeline. The line
// under it says how many kinds the purpose hides; the caller counts them, so the number here is
// made up.
const meta = {
  title: 'Pipeline/Components/PipelinePurposeSelect',
  component: PipelinePurposeSelect,
  parameters: { width: 'narrow' },
  args: { purpose: 'build' },
} satisfies Meta<typeof PipelinePurposeSelect>
export default meta

type Story = StoryObj<typeof meta>

/** Build, which hides nothing. */
export const Default: Story = {}

/** Bug fix, which holds back 14 kinds. */
export const WithHiddenCount: Story = { args: { purpose: 'bugfix', hiddenCount: 14 } }

/**
 * A purpose saved by a newer build: named as unrecognised and quoted back, and the menu still
 * offers every purpose this build knows.
 */
export const Unrecognized: Story = { args: { purpose: 'migration' as PipelinePurpose } }

/** Every purpose, with a check on the current one. */
export const Open: Story = {
  render: (args) => ({
    components: { PipelinePurposeSelect },
    setup: () => ({ args }),
    template: '<div class="pb-80"><PipelinePurposeSelect v-bind="args" /></div>',
  }),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('pipeline-purpose-select'))
  },
}
