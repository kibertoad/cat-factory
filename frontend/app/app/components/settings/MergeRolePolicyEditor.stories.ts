import type { Meta, StoryObj } from '@storybook/vue3'
import { fn, userEvent, within } from 'storybook/test'
import MergeRolePolicyEditor from './MergeRolePolicyEditor.vue'

// The role layer of one merge policy: what happens to a run depending on who started it. Per
// role, a switch holds its runs to dry runs (a pull request, and nothing merges), an allowlist
// limits the change classes it may land, and class rules can be stricter than the policy's own.
// A role row opens on its button; the editor emits each change and does not keep it.
//
// The policy auto-merges docs and never merges schema changes. Members must have docs reviewed
// against the thresholds and never auto-merge source; viewers are on dry runs.
const meta = {
  title: 'Settings/Components/MergeRolePolicyEditor',
  component: MergeRolePolicyEditor,
  parameters: { width: 'prose' },
  args: {
    classRules: { docs: 'always', schema: 'never' },
    classRulesByRole: { member: { docs: 'thresholds', source: 'never' } },
    dryRunRoles: ['viewer'],
    submissionClassesByRole: {},
    autoMergeEnabled: true,
    'onUpdate:classRulesByRole': fn(),
    'onUpdate:dryRunRoles': fn(),
    'onUpdate:submissionClassesByRole': fn(),
  },
} satisfies Meta<typeof MergeRolePolicyEditor>
export default meta

type Story = StoryObj<typeof meta>

const openMember = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await userEvent.click(within(canvasElement).getByTestId('merge-role-expand-member'))
}

/** Three roles, closed: members have two class rules, and viewers are on dry runs. */
export const Default: Story = {}

/** No role is limited: every row says it has no class limits. */
export const Empty: Story = { args: { classRulesByRole: {}, dryRunRoles: [] } }

/**
 * The member row open: the allowlist switch, then a rule per class. Schema has no stricter rule
 * to offer, because the policy already never merges it.
 */
export const Expanded: Story = {
  play: async (context) => {
    await openMember(context)
    await within(context.canvasElement).findByTestId('merge-role-submission-member')
  },
}

/** Members limited to an empty allowlist: the badge on the row, and the lands-nothing line. */
export const LandsNothing: Story = {
  args: { submissionClassesByRole: { member: [] } },
  play: async (context) => {
    await openMember(context)
    await within(context.canvasElement).findByTestId('merge-role-submission-none-member')
  },
}

/** Auto-merge off: the warning that class rules have nothing left to make stricter. */
export const AutoMergeOff: Story = { args: { autoMergeEnabled: false } }
