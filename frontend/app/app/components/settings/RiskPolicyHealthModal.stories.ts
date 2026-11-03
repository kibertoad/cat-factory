import type { Meta, StoryObj } from '@storybook/vue3'
import {
  manualReviewPolicy,
  riskPolicy,
  riskPolicyCatalogVersions,
} from '~/stories/policies.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useRiskPoliciesStore } from '~/stores/riskPolicies'
import { useUiStore } from '~/stores/ui'
import type { RiskPolicyLibraryEntry } from '@cat-factory/contracts'
import RiskPolicyHealthModal from './RiskPolicyHealthModal.vue'

// The advisory the board opens once per session when the built-in merge policies moved ahead of
// the board's copies: a catalog id the board lacks is new (Add), a copy below its catalog version
// is outdated (Reseed). Each story seeds the board's policies and the catalog versions and opens
// the modal.
//
// A new policy shows its id with the prefix dropped ("unattended", capitalised by the row), not
// the catalog name "Unattended delivery": unlike the model presets, the snapshot carries no names
// for the policy catalog.
const balancedV5 = riskPolicy({ version: 5 })
const unattended = riskPolicy({
  id: 'mp_unattended',
  name: 'Unattended delivery',
  autonomy: 'unattended',
  isDefault: false,
  isUnattendedDefault: true,
  version: 1,
})

const opened = (policies: RiskPolicyLibraryEntry[]) =>
  withSeed(() => {
    useRiskPoliciesStore().hydrate(policies, riskPolicyCatalogVersions)
    useUiStore().openRiskPolicyHealth()
  })

const meta = {
  title: 'Board/Components/RiskPolicyHealthModal',
  component: RiskPolicyHealthModal,
} satisfies Meta<typeof RiskPolicyHealthModal>
export default meta

type Story = StoryObj<typeof meta>

/** Unattended delivery to add, Balanced to update from version 5 to 6, and Reseed all. */
export const Default: Story = { decorators: [opened([balancedV5, manualReviewPolicy])] }

/** Every built-in current: the all-valid line and Done. */
export const Empty: Story = {
  decorators: [opened([riskPolicy(), manualReviewPolicy, unattended])],
}

/** Only Unattended delivery to add: one section, and no Reseed all. */
export const OnlyNew: Story = { decorators: [opened([riskPolicy(), manualReviewPolicy])] }
