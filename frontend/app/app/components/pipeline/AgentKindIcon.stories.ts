import type { Meta, StoryObj } from '@storybook/vue3'
import AgentKindIcon from './AgentKindIcon.vue'

// An agent kind's icon in its colour, with an optional label, read off `agentKindMeta`. The
// tooltip is the label and the kind's description.
const meta = {
  title: 'Pipeline/Components/AgentKindIcon',
  component: AgentKindIcon,
} satisfies Meta<typeof AgentKindIcon>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: { kind: 'architect' } }

export const WithLabel: Story = { args: { kind: 'coder', showLabel: true } }

/** A kind neither the build nor the deployment knows: the generic "Agent" icon and label. */
export const UnknownKind: Story = { args: { kind: 'acme-security-scanner', showLabel: true } }
