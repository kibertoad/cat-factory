import type { Meta, StoryObj } from '@storybook/vue3'
import type { StepToolServers as StepToolServersRecord } from '@cat-factory/contracts'
import StepToolServers from './StepToolServers.vue'

// The tool servers (MCP) one dispatch gave its agent, what the agent's CLI said about each when
// it started, and the declared servers that were dropped with the reason and the fix. The record is
// written on every container dispatch; the card renders nothing when it holds no server, which is
// every step on a deployment that registers none. The servers here are invented: a deployment
// registers its own.
const record = (overrides: Partial<StepToolServersRecord> = {}): StepToolServersRecord => ({
  wired: [
    { id: 'issues', label: 'Issue tracker', transport: 'http' },
    { id: 'docs', label: 'Docs search', transport: 'stdio', tools: ['search', 'fetch_page'] },
  ],
  unavailable: [],
  agentKind: 'coder',
  observed: [
    { id: 'issues', status: 'ready', toolCount: 12 },
    { id: 'docs', status: 'failed' },
  ],
  ...overrides,
})

const meta = {
  title: 'Pipeline/Components/StepToolServers',
  component: StepToolServers,
  parameters: { width: 'panel' },
  args: { toolServers: record(), stepAgentKind: 'coder' },
} satisfies Meta<typeof StepToolServers>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Two servers wired: one started with its tools, one narrowed to two tools that failed to start.
 */
export const Default: Story = {}

/** Two declared servers dropped, each with why and what to do. */
export const Dropped: Story = {
  args: {
    toolServers: record({
      unavailable: [
        { id: 'figma', label: 'Figma', reason: 'oauth_not_connected' },
        { id: 'sentry', label: 'Sentry', reason: 'missing_secret' },
      ],
    }),
  },
}

/** A helper ran on this step, so the card says whose servers these are. */
export const DispatchedAsHelper: Story = {
  args: { toolServers: record({ agentKind: 'ci-fixer' }) },
}

/** The CLI reported a server this dispatch did not wire. */
export const Unattributed: Story = {
  args: {
    toolServers: record({
      observed: [
        { id: 'issues', status: 'ready', toolCount: 12 },
        { id: 'docs', status: 'ready', toolCount: 2 },
        { id: 'playwright', status: 'ready', toolCount: 21 },
      ],
    }),
  },
}
