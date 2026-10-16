import type { Meta, StoryObj } from '@storybook/vue3'
import { fn } from 'storybook/test'
import { mergeClassRollups } from '~/stories/mergeTrackRecord.stories.mocks'
import { manualReviewPolicy, riskPolicy } from '~/stories/policies.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useMergeTrackRecordsStore } from '~/stores/mergeTrackRecords'
import RiskPolicyEditorRow from './RiskPolicyEditorRow.vue'

// One editable merge policy: its name, the risk, impact and complexity ceilings, the loop budgets,
// the per-class and per-role merge rules, the fork gate, the autonomy posture and auto-merge. A
// board's row also carries the two default claims (which policy governs a task that picked none,
// and which governs an unwatched run), each with its badge or a button that claims it; an account
// row has neither. The stories pass the policy as args and seed the board's merge track record,
// which the class rules show; the row emits its edits and saves nothing itself.
const meta = {
  title: 'Settings/Components/RiskPolicyEditorRow',
  component: RiskPolicyEditorRow,
  args: {
    policy: riskPolicy(),
    busy: null,
    showDefaults: true,
    onSave: fn(),
    onPromote: fn(),
    onPromoteUnattended: fn(),
    onRemove: fn(),
  },
  decorators: [
    withSeed(() => {
      seedWorkspace()
      const store = useMergeTrackRecordsStore()
      store.rollups = mergeClassRollups
      store.loaded = true
    }),
  ],
  parameters: { width: 'prose' },
} satisfies Meta<typeof RiskPolicyEditorRow>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Balanced, the board's default: the Default badge, the button that also makes it the unattended
 * default, and a delete button that is off while it is a default.
 */
export const Default: Story = {}

/** The default for both cases: two badges, and delete off with the reason naming both. */
export const BothDefaults: Story = {
  args: { policy: riskPolicy({ isUnattendedDefault: true }) },
}

/** An account policy: no default badges or buttons, and delete on. */
export const AccountTier: Story = {
  args: {
    policy: { ...manualReviewPolicy, id: 'mp_acct_manual', tier: 'account' },
    showDefaults: false,
  },
}

/** The fork gate on: its four floors and what to do when a task has no estimate. */
export const ForkGateOn: Story = {
  args: {
    policy: riskPolicy({
      isDefault: false,
      forkDecision: {
        enabled: true,
        minComplexity: 0.6,
        minRisk: 0.5,
        minImpact: 0.4,
        onMissingEstimate: 'skip',
      },
    }),
  },
}

/** Unattended: runs answer their own quality-loop questions, above a confidence floor. */
export const Unattended: Story = {
  args: { policy: riskPolicy({ isDefault: false, autonomy: 'unattended' }) },
}
