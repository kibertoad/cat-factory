import type { Meta, StoryObj } from '@storybook/vue3'
import ConnectionWarnings from './ConnectionWarnings.vue'

// Non-fatal findings about a connection that works: a gap in a runner-pool manifest, or a token
// that reaches more than it needs. Each code has translated copy; a code this build does not know
// shows the backend's English message instead, which the typed fixtures cannot reach. An empty
// list renders nothing.
const meta = {
  title: 'Settings/Components/ConnectionWarnings',
  component: ConnectionWarnings,
  parameters: { width: 'panel' },
} satisfies Meta<typeof ConnectionWarnings>
export default meta

type Story = StoryObj<typeof meta>

/** A runner-pool connection test, under the default heading. */
export const Default: Story = {
  args: {
    warnings: [
      { code: 'runner_manifest_no_release', message: 'The manifest has no release template.' },
    ],
  },
}

/** A personal token's reach, under the title the user-secrets section passes. */
export const TokenReach: Story = {
  args: {
    title: 'What this token reaches',
    warnings: [
      { code: 'github_pat_classic_account_wide', message: 'Classic token with repo scope.' },
      { code: 'github_pat_scopes_beyond_need', message: 'Token grants unused scopes.' },
    ],
  },
}
