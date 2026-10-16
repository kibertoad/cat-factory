import type { Meta, StoryObj } from '@storybook/vue3'
import type { TaskConnection, TaskSourceKind, TaskSourceState } from '@cat-factory/contracts'
import { taskConnections, taskSources } from '~/stories/integrations.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useTasksStore } from '~/stores/tasks'
import { useUiStore } from '~/stores/ui'
import TaskSourceConnectModal from './TaskSourceConnectModal.vue'

// Connect one issue tracker to the board, or manage it once connected. The form is built from
// the tracker's descriptor (its credential fields), so Jira and Linear share it; Linear also
// offers its OAuth button. GitHub Issues has no credentials, because it uses the board's GitHub
// App, so it shows only whether the board offers its issues. Each story seeds the tracker probe
// and opens the modal on one tracker.
function opened(
  source: TaskSourceKind,
  options: { connections?: TaskConnection[]; sources?: TaskSourceState[] } = {},
) {
  return withSeed(() => {
    seedWorkspace()
    const tasks = useTasksStore()
    tasks.available = true
    tasks.sources = options.sources ?? taskSources
    tasks.connections = options.connections ?? []
    useUiStore().openTaskConnect(source)
  })
}

const meta = {
  title: 'Settings/Components/TaskSourceConnectModal',
  component: TaskSourceConnectModal,
  decorators: [
    opened('jira', {
      sources: taskSources.map((s) => (s.source === 'jira' ? { ...s, available: false } : s)),
    }),
  ],
} satisfies Meta<typeof TaskSourceConnectModal>
export default meta

type Story = StoryObj<typeof meta>

/** Jira, not connected: its credential fields and Connect. */
export const Default: Story = {}

/**
 * Jira, connected to the Acme site: the site, the offer switch, Disconnect, and an Update
 * connection button that stays off, because the form it would submit is hidden.
 */
export const Connected: Story = { decorators: [opened('jira', { connections: taskConnections })] }

/** GitHub Issues, on a board with the App installed: no form, only the offer switch. */
export const Credentialless: Story = { decorators: [opened('github')] }

/** GitHub Issues with no App installed: the hint to install it, and nothing to switch. */
export const CredentiallessUnavailable: Story = {
  decorators: [
    opened('github', {
      sources: taskSources.map((s) => (s.source === 'github' ? { ...s, available: false } : s)),
    }),
  ],
}

/** Linear, not connected: Connect with Linear above its API key field. */
export const OAuth: Story = { decorators: [opened('linear')] }
