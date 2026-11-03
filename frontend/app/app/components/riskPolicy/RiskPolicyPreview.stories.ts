import type { Meta, StoryObj } from '@storybook/vue3'
import { manualReviewPolicy, riskPolicy } from '~/stories/policies.stories.mocks'
import RiskPolicyPreview from './RiskPolicyPreview.vue'

// What a merge policy does, in the words the task picker and the inherited row both use: the
// three ceilings under which a pull request merges on its own (or that nothing merges on its own),
// what changes with who started the run, and how many CI fix attempts a run gets. The role layer
// shows only on a policy that has one.
const meta = {
  title: 'Inspector/Components/RiskPolicyPreview',
  component: RiskPolicyPreview,
  parameters: { width: 'narrow' },
  args: { policy: riskPolicy({ isDefault: false }) },
} satisfies Meta<typeof RiskPolicyPreview>
export default meta

type Story = StoryObj<typeof meta>

/** Balanced: auto-merge on, with its risk, impact and complexity ceilings. */
export const Default: Story = {}

/** Manual review only: auto-merge off, so no ceiling applies. */
export const AutoMergeOff: Story = { args: { policy: manualReviewPolicy } }

/** The workspace's default policy carries the default badge. */
export const WorkspaceDefault: Story = { args: { policy: riskPolicy() } }

/**
 * A policy with a role layer: viewers on dry runs, members limited to docs and tests, and
 * members held to a stricter rule for source changes. The policy is made up.
 */
export const RoleLayer: Story = {
  args: {
    policy: riskPolicy({
      id: 'mp_release_train',
      name: 'Release train',
      isDefault: false,
      dryRunRoles: ['viewer'],
      submissionClassesByRole: { member: ['docs', 'test'] },
      classRulesByRole: { member: { source: 'never' } },
    }),
  },
}
