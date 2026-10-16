import type { Meta, StoryObj } from '@storybook/vue3'
import type { Pipeline, WorkspaceSnapshot } from '@cat-factory/contracts'
import { DEFAULT_TRACKER_WRITEBACK } from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { shellProbeApi } from '~/stories/shellApi'
import { authService } from '~/stories/board.stories.mocks'
import { bugTriagePipeline } from '~/stories/pipelines.stories.mocks'
import { taskFormSnapshot } from '~/stories/taskForm.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import RecurringPipelineModal from './RecurringPipelineModal.vue'

// The form that adds a recurring pipeline to a service. The person names it, picks a pipeline and
// a cadence, or makes it on-demand. What else it asks follows the picked pipeline: one that files
// a ticket asks where, and one that pulls its work from a tracker asks which board and which
// issues. Any other pipeline can opt in to runs started from tracker webhooks. It opens on the
// first pipeline a schedule can run; the stories that need another one pick it, as a person does.
// The trackers are the shared ones: GitHub Issues and Jira connected, Linear not. The schedule is
// only planned here: Add sends a request no story answers.

/**
 * A pipeline a workspace composed around the analyst and the tracker step, which files a ticket
 * from the audit before the change is made. No built-in files one since the tech-debt preset was
 * retired.
 */
const techDebtAudit: Pipeline = {
  id: 'pl_ws_tech_debt',
  name: 'Tech-debt audit',
  purpose: 'build',
  description: 'Audit the service, file a ticket for the worst finding, then fix it.',
  agentKinds: ['analysis', 'tracker', 'coder', 'reviewer', 'conflicts', 'ci', 'merger'],
}

/** The task form board, with the two pipelines that are only of use on a schedule. */
function scheduleBoard(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  const board = taskFormSnapshot(overrides)
  return { ...board, pipelines: [...board.pipelines, bugTriagePipeline, techDebtAudit] }
}

function opened(board = scheduleBoard()) {
  return withSeed(() => {
    seedSnapshot(board)
    useUiStore().openAddRecurring(authService.id)
  })
}

async function pickPipeline(id: string) {
  await userEvent.click(await screen.findByTestId('pipeline-picker-trigger'))
  await userEvent.click(await screen.findByTestId(`pipeline-option-${id}`))
}

/** The switches in order: on-demand, then the tracker trigger. */
async function switchNumber(index: number) {
  const switches = await screen.findAllByRole('switch')
  return switches[index]!
}

const meta = {
  title: 'Board/Components/RecurringPipelineModal',
  component: RecurringPipelineModal,
  parameters: { api: shellProbeApi() },
} satisfies Meta<typeof RecurringPipelineModal>
export default meta

type Story = StoryObj<typeof meta>

/** A weekly Standard build on Auth Service: the name, the pipeline, the prompt and the cadence. */
export const Default: Story = {
  decorators: [opened()],
}

/** On-demand: no cadence, so the recurrence editor goes. */
export const OnDemand: Story = {
  decorators: [opened()],
  play: async () => {
    await userEvent.click(await switchNumber(0))
  },
}

/**
 * A pipeline that files a ticket: where to file it, saved for the whole workspace. The workspace
 * files in Jira, under AUTH.
 */
export const IssueTracker: Story = {
  decorators: [
    opened(
      scheduleBoard({
        trackerSettings: {
          tracker: 'jira',
          jiraProjectKey: 'AUTH',
          linearTeamId: null,
          ...DEFAULT_TRACKER_WRITEBACK,
          updatedAt: Date.UTC(2026, 8, 4),
        },
      }),
    ),
  ],
  play: () => pickPipeline(techDebtAudit.id),
}

/**
 * Bug triage, which pulls its work from a tracker board: Jira picked, so its project key, the
 * filters, and the line that says a webhook event drains the board.
 */
export const BugIntake: Story = {
  decorators: [opened()],
  play: async () => {
    await pickPipeline(bugTriagePipeline.id)
    await userEvent.click(await screen.findByRole('button', { name: 'Jira' }))
  },
}

/** Bug triage on a deployment that offers no tracker: the line that says to connect one. */
export const NoIntakeSources: Story = {
  decorators: [opened()],
  parameters: { api: shellProbeApi({ tasks: false }) },
  play: () => pickPipeline(bugTriagePipeline.id),
}

/**
 * Runs started from tracker webhooks, on the Standard build: on-demand is locked on, and with
 * GitHub Issues picked each matching ticket becomes its own task.
 */
export const TrackerTrigger: Story = {
  decorators: [opened()],
  play: async () => {
    await userEvent.click(await switchNumber(1))
    await userEvent.click(await screen.findByRole('button', { name: 'GitHub Issues' }))
  },
}
