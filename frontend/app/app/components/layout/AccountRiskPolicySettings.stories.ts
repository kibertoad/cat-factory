import type { Meta, StoryObj } from '@storybook/vue3'
import type { RiskPolicyLibraryEntry } from '@cat-factory/contracts'
import { listRiskPoliciesContract } from '@cat-factory/contracts'
import { apiPending, apiResponse } from '~/stories/api'
import { orgAccount } from '~/stories/accounts.stories.mocks'
import { manualReviewPolicy, riskPolicy } from '~/stories/policies.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useMergeTrackRecordsStore } from '~/stores/mergeTrackRecords'
import AccountRiskPolicySettings from './AccountRiskPolicySettings.vue'

// The account's own merge policies, which every board in the account inherits read-only: one
// editor row per policy, and the form that adds one. An account policy is never a default,
// because which policy governs a task that picked none is a per-board choice, so the rows have
// no default badges or promote buttons. The panel loads the account's library when it mounts,
// so each story answers that read. Each row's class rules show the merge track record of the
// board the settings were opened from, so the story opens them from the story board, with no
// merges recorded yet.
const accountPrefix = `/accounts/${orgAccount.id}`

/** The account's copies of Balanced and Manual review only. */
const accountPolicies: RiskPolicyLibraryEntry[] = [
  riskPolicy({ id: 'mp_acct_balanced', isDefault: false, tier: 'account' }),
  { ...manualReviewPolicy, id: 'mp_acct_manual', tier: 'account' },
]

function policiesAre(body: RiskPolicyLibraryEntry[]) {
  return apiResponse(listRiskPoliciesContract, { pathPrefix: accountPrefix, body })
}

const meta = {
  title: 'Settings/Components/AccountRiskPolicySettings',
  component: AccountRiskPolicySettings,
  args: { accountId: orgAccount.id },
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useMergeTrackRecordsStore().loaded = true
    }),
  ],
  parameters: { width: 'prose', api: [policiesAre(accountPolicies)] },
} satisfies Meta<typeof AccountRiskPolicySettings>
export default meta

type Story = StoryObj<typeof meta>

/** Two policies, each in an editor row, and the create form under them. */
export const Default: Story = {}

/** No account policies yet: the empty state above the create form. */
export const Empty: Story = { parameters: { api: [policiesAre([])] } }

/** The first load in flight: two placeholder rows. */
export const Loading: Story = {
  parameters: { api: [apiPending(listRiskPoliciesContract, { pathPrefix: accountPrefix })] },
}
