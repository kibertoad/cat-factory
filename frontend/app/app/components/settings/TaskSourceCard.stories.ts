import type { Meta, StoryObj } from '@storybook/vue3'
import { fn } from 'storybook/test'
import { taskSources } from '~/stories/integrations.stories.mocks'
import TaskSourceCard from './TaskSourceCard.vue'

// One issue tracker in the issue tracker settings: what makes it usable or what is missing, the
// setup check, and the on/off switch (or the button that fixes what is missing). A tracker
// either rides the workspace's VCS connection or has credentials of its own, and the line under
// its name and the fix button follow that. The setup check verdicts are the backend's own words.
const [githubIssues, jira, linear] = taskSources as [
  (typeof taskSources)[number],
  (typeof taskSources)[number],
  (typeof taskSources)[number],
]

const meta = {
  title: 'Settings/Components/TaskSourceCard',
  component: TaskSourceCard,
  parameters: { width: 'prose' },
  args: { state: jira, onCheck: fn(), onToggle: fn(), onRemedy: fn() },
} satisfies Meta<typeof TaskSourceCard>
export default meta

type Story = StoryObj<typeof meta>

/** Jira, connected with its own credentials and switched on. */
export const Default: Story = {}

/** GitHub Issues, which uses the workspace's GitHub connection and names it. */
export const RidesVcsConnected: Story = { args: { state: githubIssues } }

/** GitHub Issues with no GitHub connection: the button leads to connecting GitHub. */
export const RidesVcsMissing: Story = { args: { state: { ...githubIssues, available: false } } }

/** Linear, not connected: the button leads to its own connect form. */
export const NotConnected: Story = { args: { state: linear } }

/** A passing setup check under the row. */
export const DiagnosticReady: Story = {
  args: {
    diagnostic: {
      status: 'ready',
      message: 'Authenticated to https://acme.atlassian.net.',
      detail: 'Signed in as Maya Lindqvist.',
    },
  },
}

/** Jira refused the stored credentials. */
export const DiagnosticAuthFailed: Story = {
  args: {
    diagnostic: {
      status: 'auth_failed',
      message:
        'Jira rejected the account email or API token (401). Re-check the email and generate a ' +
        'fresh API token, then reconnect.',
    },
  },
}

/** A setup check in flight: the check button spins. */
export const Checking: Story = { args: { checking: true } }
