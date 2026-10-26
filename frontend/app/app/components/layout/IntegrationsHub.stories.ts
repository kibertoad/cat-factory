import type { Meta, StoryObj } from '@storybook/vue3'
import {
  DEFAULT_TRACKER_WRITEBACK,
  getObservabilityConnectionContract,
  listReleaseHealthConfigsContract,
  listUserSecretsContract,
} from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { signedInUser } from '~/stories/accounts.stories.mocks'
import { apiFailure, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import {
  documentConnections,
  documentSources,
  slackConnection,
  taskSources,
} from '~/stories/integrations.stories.mocks'
import { githubConnection } from '~/stories/vcs.stories.mocks'
import { seedDocumentSources, seedUiMode, seedWorkspace, withSeed } from '~/stories/withStores'
import { useAuthStore } from '~/stores/auth'
import { useGitHubStore } from '~/stores/github'
import { usePublicApiKeysStore } from '~/stores/publicApiKeys'
import { useReleaseHealthStore } from '~/stores/releaseHealth'
import { useSlackStore } from '~/stores/slack'
import { useTasksStore } from '~/stores/tasks'
import { useTrackerStore } from '~/stores/tracker'
import { useUiStore } from '~/stores/ui'
import IntegrationsHub from './IntegrationsHub.vue'

// The Integrations window: the optional systems a board links in, in groups (source control,
// communication, documents, trackers, observability, API tokens), connected rows first, with a
// search over them. Each row opens that system's own window. A group shows only when the shell's
// probe found the system offered, so each story seeds what the probes found. The window loads
// the observability connection and the API tokens once, which the stories seed too, and the
// person's own secrets each time it opens, which each story answers. The observability row is
// for the advanced tier only, unless a connection exists.

interface Connected {
  github: boolean
  slack: boolean
  documents: boolean
  trackers: boolean
}

/**
 * The hub opened over a board whose probes found every system offered, with the ones in
 * `connected` connected, and the person signed in unless `signedIn` is false.
 */
function opened(
  connected: Connected = { github: true, slack: true, documents: true, trackers: true },
  signedIn = true,
) {
  return withSeed(() => {
    seedWorkspace()
    useAuthStore().user = signedIn ? signedInUser : null
    const github = useGitHubStore()
    github.available = true
    github.connection = connected.github ? githubConnection : null
    const slack = useSlackStore()
    slack.available = true
    slack.connection = connected.slack ? slackConnection : null
    seedDocumentSources(documentSources, connected.documents ? documentConnections : [])
    const tasks = useTasksStore()
    tasks.available = true
    tasks.sources = connected.trackers
      ? taskSources
      : taskSources.map((s) => ({ ...s, available: false }))
    // Set in full each time: the meta's decorator has run first and set its own.
    useTrackerStore().settings = {
      tracker: connected.trackers ? 'jira' : null,
      jiraProjectKey: connected.trackers ? 'AUTH' : null,
      linearTeamId: null,
      ...DEFAULT_TRACKER_WRITEBACK,
      updatedAt: Date.UTC(2026, 8, 4),
    }
    useReleaseHealthStore().available = true
    usePublicApiKeysStore().available = true
    useUiStore().openIntegrations()
  })
}

const meta = {
  title: 'Settings/Components/IntegrationsHub',
  component: IntegrationsHub,
  decorators: [opened()],
  parameters: {
    api: [apiResponse(listUserSecretsContract, { body: { secrets: [], descriptors: [] } })],
  },
} satisfies Meta<typeof IntegrationsHub>
export default meta

type Story = StoryObj<typeof meta>

/**
 * GitHub, Slack, three document sources and two trackers connected, each group with its connected
 * rows first, and Jira named as the filing tracker.
 */
export const Default: Story = {}

/** Nothing connected: the get-started line, with GitHub marked Recommended. */
export const NothingConnected: Story = {
  decorators: [opened({ github: false, slack: false, documents: false, trackers: false })],
}

/** A search that matches nothing. */
export const NoResults: Story = {
  play: async () => {
    await userEvent.type(await screen.findByRole('textbox'), 'zendesk')
    await screen.findByText('No integrations match "zendesk".')
  },
}

/** The advanced tier: the observability group too. */
export const Advanced: Story = {
  decorators: [withSeed(() => seedUiMode('advanced'))],
}

/**
 * A deployment with no sign-in, so no "My setup" window: the person's own GitHub token comes
 * back here, under Personal.
 */
export const AuthDisabled: Story = {
  decorators: [opened(undefined, false)],
}

/**
 * The observability read failed: the row shows on the basic tier too, with a failed badge, so the
 * panel behind it (and its retry) stays reachable.
 */
export const ObservabilityFailed: Story = {
  decorators: [
    withSeed(() => {
      useReleaseHealthStore().available = null
    }),
  ],
  parameters: {
    api: [
      apiResponse(listUserSecretsContract, { body: { secrets: [], descriptors: [] } }),
      apiFailure(getObservabilityConnectionContract, { pathPrefix: storyWorkspacePrefix }),
      apiResponse(listReleaseHealthConfigsContract, { pathPrefix: storyWorkspacePrefix, body: [] }),
    ],
  },
  play: async () => {
    await screen.findByTestId('integrations-failed-observability')
  },
}
