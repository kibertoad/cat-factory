import type { Meta, StoryObj } from '@storybook/vue3'
import { fn } from 'storybook/test'
import { mergeClassRollups } from '~/stories/mergeTrackRecord.stories.mocks'
import MergeEffortChips from './MergeEffortChips.vue'

// How much work a person's review needed, tagged on a merge: none, minor or major. The run's
// change class shows beside the question, with the class's history under the chips: how many
// changes of the class landed and what share merged on their own. Picking the chosen chip again
// clears the tag.
const source = mergeClassRollups.find((rollup) => rollup.changeClass === 'source')!

const meta = {
  title: 'Review/Components/MergeEffortChips',
  component: MergeEffortChips,
  parameters: { width: 'panel' },
  args: {
    modelValue: null,
    changeClass: 'source',
    rollup: source,
    'onUpdate:modelValue': fn(),
  },
} satisfies Meta<typeof MergeEffortChips>
export default meta

type Story = StoryObj<typeof meta>

/** Nothing chosen: the source code badge, and 28 merged source changes, 14.3% of them on their own. */
export const Default: Story = {}

/** Minor chosen: the solid chip. */
export const Selected: Story = { args: { modelValue: 'minor' } }

/** No change class and no history: the chips alone. */
export const NoHistory: Story = { args: { changeClass: undefined, rollup: null } }

/** Disabled, for someone who may not tag. */
export const Disabled: Story = { args: { disabled: true } }
