import type { Meta, StoryObj } from '@storybook/vue3'
import type { SourceTask, TaskSourceState } from '@cat-factory/contracts'
import { listTasksContract, searchTasksContract } from '@cat-factory/contracts'
import { screen, userEvent, within } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authInitiative, boardWithInitiative, loginTask } from '~/stories/board.stories.mocks'
import {
  authServiceIssues,
  sourceTask,
  sourceTasks,
  taskSources,
} from '~/stories/integrations.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { useTasksStore } from '~/stores/tasks'
import TaskContextIssues from './TaskContextIssues.vue'

// The tracker issues attached to a task or an initiative as agent context, each a link to the
// issue with its status as the tracker names it. Attach opens the same inline picker as the
// add-task form; a pick is imported if needed and linked at once. With no tracker offered, the
// section offers to connect one instead. The trackers are seeded on the tasks store, and the
// imported issues are answered for the section's load and the picker's. The section starts
// closed, so each story opens it. A pick and a connect send requests no story answers.

/** The Jira bug and GitHub issue #88, attached to the login task; #91 is imported and free. */
const linkedToLogin: SourceTask[] = [
  { ...sourceTasks[0]!, linkedBlockId: loginTask.id },
  { ...authServiceIssues[0]!, linkedBlockId: loginTask.id },
  authServiceIssues[1]!,
]

const meta = {
  title: 'Inspector/Components/TaskContextIssues',
  component: TaskContextIssues,
  args: { block: loginTask },
  decorators: [withTrackers(taskSources)],
  parameters: {
    width: 'panel',
    api: [
      issuesAre(linkedToLogin),
      apiResponse(searchTasksContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { source: 'github' },
        body: { results: [] },
      }),
    ],
  },
} satisfies Meta<typeof TaskContextIssues>
export default meta

type Story = StoryObj<typeof meta>

function issuesAre(body: SourceTask[]) {
  return apiResponse(listTasksContract, { pathPrefix: storyWorkspacePrefix, body })
}

/** Put the trackers the workspace offers on the tasks store, as its probe would. */
function withTrackers(sources: TaskSourceState[]) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(boardWithInitiative)
    const tasks = useTasksStore()
    tasks.available = true
    tasks.sources = sources
  })
}

async function openSection(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByTestId('inspector-section-toggle'))
}

/** Open the section, then wait for what the story shows. */
function opensTo(shown: (canvas: ReturnType<typeof within>) => Promise<unknown>) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSection(canvasElement)
    await shown(within(canvasElement))
  }
}

/**
 * Two issues: the Jira key and the GitHub reference before each title, and the status as each
 * tracker writes it ("To Do", "open"). The GitHub row's title is cut at the panel's width.
 */
export const Default: Story = { play: opensTo((c) => c.findByText('To Do')) }

/** Nothing attached: the empty state, which names Jira whichever tracker is connected. */
export const Empty: Story = {
  parameters: { api: [issuesAre(authServiceIssues)] },
  play: opensTo((c) =>
    c.findByText(
      'Attach a Jira issue so agents see its description and comments while implementing this task.',
    ),
  ),
}

/** On an initiative the hint and the empty state name the planning agents instead. */
export const Initiative: Story = {
  args: { block: authInitiative },
  parameters: {
    api: [
      issuesAre([
        sourceTask({
          externalId: 'AUTH-100',
          title: 'Identity platform',
          url: 'https://acme.atlassian.net/browse/AUTH-100',
          type: 'Epic',
          priority: 'High',
          linkedBlockId: authInitiative.id,
        }),
      ]),
    ],
  },
  play: opensTo((c) =>
    c.findByText(
      'Tracker issues attached to this initiative as context. Their content is given to the planning agents that shape it.',
    ),
  ),
}

/**
 * Attach clicked: the picker opens under the title, with its tracker menu and the GitHub issue
 * not attached yet.
 */
export const PickerOpen: Story = {
  play: async ({ canvasElement }) => {
    await openSection(canvasElement)
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Attach' }))
    await within(canvasElement).findAllByText('imported')
  },
}

/** No tracker offered, and the deployment registers only Jira: one button that names it. */
export const ConnectOneSource: Story = {
  decorators: [
    withTrackers(
      taskSources.filter((s) => s.source === 'jira').map((s) => ({ ...s, available: false })),
    ),
  ],
  parameters: { api: [issuesAre([])] },
  play: opensTo((c) => c.findByRole('button', { name: 'Connect Jira' })),
}

/** No tracker offered, and three registered: a menu. */
export const ConnectManySources: Story = {
  decorators: [withTrackers(taskSources.map((s) => ({ ...s, available: false })))],
  parameters: { api: [issuesAre([])] },
  play: async ({ canvasElement }) => {
    await openSection(canvasElement)
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Connect a source' }))
    // The menu is teleported to `body`.
    await screen.findByRole('menuitem', { name: 'Linear' })
  },
}
