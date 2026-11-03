import type { Meta, StoryObj } from '@storybook/vue3'
import type { TaskConnection, TrackerSettings } from '@cat-factory/contracts'
import { listLinearTeamsContract } from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { taskConnections, taskSources } from '~/stories/integrations.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useTasksStore } from '~/stores/tasks'
import { useTrackerStore } from '~/stores/tracker'
import IssueTrackerPanel from './IssueTrackerPanel.vue'

// A board's issue tracking in one place: which tracker the tech-debt pipeline files its tickets
// in, which trackers' issues can be linked to tasks, and what the platform writes back to a
// linked issue (a comment when the pull request opens, a comment and close when it merges, the
// open questions when a run parks). Filing and linking are separate settings. Each story seeds
// the tracker settings and the tracker probe, as the snapshot and the board's probe fill them.
function seeded(options: {
  settings?: Partial<TrackerSettings>
  connections?: TaskConnection[]
  sources?: typeof taskSources
  probeFailed?: boolean
}) {
  return withSeed(() => {
    seedWorkspace()
    const tracker = useTrackerStore()
    tracker.settings = {
      tracker: null,
      jiraProjectKey: null,
      linearTeamId: null,
      writebackCommentOnPrOpen: true,
      writebackResolveOnMerge: true,
      writebackQuestionsOnPark: false,
      updatedAt: Date.UTC(2026, 9, 1),
      ...options.settings,
    }
    const tasks = useTasksStore()
    if (options.probeFailed) {
      // A failed probe clears what an earlier one listed, as `useSourceIntegration` does.
      tasks.available = false
      tasks.probeError = { status: 500, message: 'Internal server error' }
      tasks.sources = []
      tasks.connections = []
      return
    }
    tasks.available = true
    tasks.sources = options.sources ?? taskSources
    tasks.connections = options.connections ?? taskConnections
  })
}

const meta = {
  title: 'Settings/Components/IssueTrackerPanel',
  component: IssueTrackerPanel,
  decorators: [seeded({ settings: { tracker: 'github' } })],
  parameters: { width: 'prose' },
} satisfies Meta<typeof IssueTrackerPanel>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Filing in GitHub Issues; GitHub Issues and Jira linkable, Linear not set up; comments on open
 * and close on merge.
 */
export const Default: Story = {}

/** No tracker registered on the deployment, and nothing filed. */
export const Empty: Story = { decorators: [seeded({ sources: [], connections: [] })] }

/** Filing in Jira with no Jira connection: the hint to connect it, and the project key field. */
export const JiraNotConnected: Story = {
  decorators: [
    seeded({
      settings: { tracker: 'jira' },
      sources: taskSources.map((s) => (s.source === 'jira' ? { ...s, available: false } : s)),
      connections: [],
    }),
  ],
}

/** Filing in Linear, connected: the team typeahead over the connection's teams. */
export const LinearTeams: Story = {
  decorators: [
    seeded({
      settings: { tracker: 'linear', linearTeamId: 'team_platform' },
      sources: taskSources.map((s) => (s.source === 'linear' ? { ...s, available: true } : s)),
      connections: [
        ...taskConnections,
        { source: 'linear', label: 'Acme', connectedAt: Date.UTC(2026, 9, 1) },
      ],
    }),
  ],
  parameters: {
    api: [
      apiResponse(listLinearTeamsContract, {
        pathPrefix: storyWorkspacePrefix,
        body: {
          teams: [
            { id: 'team_platform', name: 'Platform', key: 'PLT' },
            { id: 'team_mobile', name: 'Mobile', key: 'MOB' },
          ],
        },
      }),
    ],
  },
}

/**
 * The tracker probe failed with a 500: an alert says why nothing is listed, with the backend's
 * message in it.
 */
export const ProbeFailed: Story = { decorators: [seeded({ probeFailed: true })] }
