import type { Meta, StoryObj } from '@storybook/vue3'
import type { RiskPolicyLibraryEntry, RiskPolicySuppression } from '@cat-factory/contracts'
import { listRiskPolicySuppressionsContract } from '@cat-factory/contracts'
import { apiFailure, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { mergeClassRollups } from '~/stories/mergeTrackRecord.stories.mocks'
import {
  manualReviewPolicy,
  riskPolicy,
  riskPolicyCatalogVersions,
} from '~/stories/policies.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useMergeTrackRecordsStore } from '~/stores/mergeTrackRecords'
import { useRiskPoliciesStore } from '~/stores/riskPolicies'
import RiskPolicyPanel from './RiskPolicyPanel.vue'

// The board's merge policies: the account's, read-only with Clone and Hide, above the board's
// own, each in an editor row; then what the board hides, with Restore; then the form that adds a
// policy. The library is seeded as the snapshot carries it, with the board's merge track record;
// the hidden list is not in the snapshot, so the panel reads it when it opens and each story
// answers that read.
const pathPrefix = storyWorkspacePrefix

const accountPolicy: RiskPolicyLibraryEntry = {
  ...riskPolicy({ id: 'mp_acct_strict', name: 'Acme strict', maxRisk: 0.2, maxImpact: 0.3 }),
  isDefault: false,
  tier: 'account',
}

function seeded(presets: RiskPolicyLibraryEntry[]) {
  return withSeed(() => {
    seedWorkspace()
    useRiskPoliciesStore().hydrate(presets, riskPolicyCatalogVersions)
    const records = useMergeTrackRecordsStore()
    records.rollups = mergeClassRollups
    records.loaded = true
  })
}

function hiddenAre(body: RiskPolicySuppression[]) {
  return apiResponse(listRiskPolicySuppressionsContract, { pathPrefix, body })
}

const meta = {
  title: 'Settings/Components/RiskPolicyPanel',
  component: RiskPolicyPanel,
  decorators: [seeded([accountPolicy, riskPolicy(), manualReviewPolicy])],
  parameters: { width: 'prose', api: [hiddenAre([])] },
} satisfies Meta<typeof RiskPolicyPanel>
export default meta

type Story = StoryObj<typeof meta>

/** The account's strict policy, inherited, above the board's Balanced and Manual review only. */
export const Default: Story = {}

/** No policies at all: only the form that adds one. */
export const Empty: Story = { decorators: [seeded([])] }

/**
 * The board hides two account policies: one the account still offers, and one it has since
 * withdrawn, which says it hides nothing now.
 */
export const Hidden: Story = {
  parameters: {
    api: [
      hiddenAre([
        { id: 'mp_acct_fast', name: 'Acme fast lane', inherited: true },
        { id: 'mp_acct_legacy', name: 'Legacy release train', inherited: false },
      ]),
    ],
  },
}

/** The hidden list could not be read: a warning line where it would be. */
export const SuppressionsFailed: Story = {
  parameters: { api: [apiFailure(listRiskPolicySuppressionsContract, { pathPrefix })] },
}
