import type { Meta, StoryObj } from '@storybook/vue3'
import { listMergeClassRollupsContract } from '@cat-factory/contracts'
import { fn, screen } from 'storybook/test'
import { apiFailure } from '~/stories/api'
import { mergeClassRollups } from '~/stories/mergeTrackRecord.stories.mocks'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useMergeTrackRecordsStore } from '~/stores/mergeTrackRecords'
import MergeClassRulesEditor from './MergeClassRulesEditor.vue'

// A merge policy's rule per change class (docs, tests, dependencies, config, source, schema),
// each beside the board's track record for that class: how many merged, what share merged on its
// own, and what share needed no review effort. A class with no rule uses the score ceilings, and
// no rule can turn auto-merge on for a policy that has it off. The stories pass the rules as args
// and seed the board's track record, so nothing loads; the editor emits changes and keeps none.
const withRecord = (recorded: boolean) =>
  withSeed(() => {
    seedWorkspace()
    const store = useMergeTrackRecordsStore()
    store.rollups = recorded ? mergeClassRollups : []
    store.loaded = true
  })

const meta = {
  title: 'Settings/Components/MergeClassRulesEditor',
  component: MergeClassRulesEditor,
  args: {
    modelValue: { docs: 'always', schema: 'never' },
    autoMergeEnabled: true,
    'onUpdate:modelValue': fn(),
  },
  decorators: [withRecord(true)],
  parameters: { width: 'prose' },
} satisfies Meta<typeof MergeClassRulesEditor>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Docs always merge and schema changes never do; each class shows its record, and the classes
 * with none say so.
 */
export const Default: Story = {}

/** A new board: every class on the score ceilings, and no record yet. */
export const Empty: Story = { args: { modelValue: {} }, decorators: [withRecord(false)] }

/** The policy has auto-merge off: a warning that no class rule can turn it on. */
export const AutoMergeOff: Story = { args: { autoMergeEnabled: false } }

/** While the policy saves: every select is off. */
export const Disabled: Story = { args: { disabled: true } }

/** The track record could not be read: one error toast, and every class without a record. */
export const LoadFailed: Story = {
  decorators: [
    withSeed(() => {
      seedWorkspace()
      const store = useMergeTrackRecordsStore()
      store.rollups = []
      store.loaded = false
    }),
  ],
  parameters: {
    api: [apiFailure(listMergeClassRollupsContract, { pathPrefix: storyWorkspacePrefix })],
  },
  play: async () => {
    await screen.findByText('Could not load the merge track record')
  },
}
