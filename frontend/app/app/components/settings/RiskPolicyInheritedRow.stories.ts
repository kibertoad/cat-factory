import type { Meta, StoryObj } from '@storybook/vue3'
import { fn } from 'storybook/test'
import { riskPolicy } from '~/stories/policies.stories.mocks'
import RiskPolicyInheritedRow from './RiskPolicyInheritedRow.vue'

// A merge policy the board inherits from its account: read only, with the account badge, the two
// actions a board has over it (clone, hide) and the same preview the task picker shows. The
// policy is made up: an account policy with auto-merge on and a lower risk ceiling.
const accountPolicy = riskPolicy({
  id: 'mp_acme_strict',
  name: 'Acme strict',
  maxRisk: 0.2,
  maxImpact: 0.3,
  isDefault: false,
  version: 1,
  tier: 'account',
})

const meta = {
  title: 'Settings/Components/RiskPolicyInheritedRow',
  component: RiskPolicyInheritedRow,
  parameters: { width: 'prose' },
  args: { policy: accountPolicy, busy: null, onClone: fn(), onHide: fn() },
} satisfies Meta<typeof RiskPolicyInheritedRow>
export default meta

type Story = StoryObj<typeof meta>

/** The account badge, Clone and Hide, and the policy preview. */
export const Default: Story = {}

/** A clone request in flight: Clone spins, Hide does not. */
export const Cloning: Story = { args: { busy: 'mp_acme_strict:clone' } }
