import type { Meta, StoryObj } from '@storybook/vue3'
import { fn } from 'storybook/test'
import { AGENT_FAILURE_KINDS } from '~/utils/failureKinds'
import AccountFailureKindRules from './AccountFailureKindRules.vue'

// The per-failure-kind alert rules on an account's platform health settings: "page when this
// kind reaches this share of the failures". The account's list replaces the deployment's, so a
// checkbox says whether the account has its own list, and an empty list is a real setting. The
// warnings are the faults the save would refuse. The stories pass the list as args; the editor
// emits changes and does not keep them.
const meta = {
  title: 'Settings/Components/AccountFailureKindRules',
  component: AccountFailureKindRules,
  parameters: { width: 'prose' },
  args: {
    modelValue: [
      { kind: 'evicted', maxShare: 0.05, minCount: 3 },
      { kind: 'timeout', maxShare: 0.1 },
    ],
    'onUpdate:modelValue': fn(),
  },
} satisfies Meta<typeof AccountFailureKindRules>
export default meta

type Story = StoryObj<typeof meta>

/** Two rules: evictions at 5% once there are three, and timeouts at 10%. */
export const Default: Story = {}

/** No list of its own: the account uses the deployment's rules, so only the checkbox shows. */
export const Inheriting: Story = { args: { modelValue: undefined } }

/** Its own list, empty: no per-kind rules at all. */
export const Empty: Story = { args: { modelValue: [] } }

/** Two rules for timeouts: the duplicate warning. */
export const DuplicateKind: Story = {
  args: {
    modelValue: [
      { kind: 'timeout', maxShare: 0.1 },
      { kind: 'timeout', maxShare: 0.2 },
    ],
  },
}

/** A rule with a zero share: the warning names row 2. */
export const InvalidRows: Story = {
  args: {
    modelValue: [
      { kind: 'evicted', maxShare: 0.05 },
      { kind: 'timeout', maxShare: 0 },
    ],
  },
}

/**
 * A rule stored for a kind this build no longer has. The select offers it back, marked as not
 * recognised, instead of moving the rule to another kind. The kind is made up.
 */
export const RetiredKind: Story = {
  args: { modelValue: [{ kind: 'container_lost', maxShare: 0.05 }] },
}

/** One rule for every kind: Add is disabled and the all-covered note shows. */
export const AllKindsCovered: Story = {
  args: { modelValue: AGENT_FAILURE_KINDS.map((kind) => ({ kind, maxShare: 0.1 })) },
}
