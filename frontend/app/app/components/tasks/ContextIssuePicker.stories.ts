import type { Meta, StoryObj } from '@storybook/vue3'
import type { TaskSourceState } from '@cat-factory/contracts'
import { listTasksContract, searchTasksContract } from '@cat-factory/contracts'
import { screen, userEvent, within } from 'storybook/test'
import { apiRefusal, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService } from '~/stories/board.stories.mocks'
import {
  authServiceIssues,
  sessionSearchHits,
  taskSources,
} from '~/stories/integrations.stories.mocks'
import { seedTaskSources, seedWorkspace, withSeed } from '~/stories/withStores'
import ContextIssuePicker from './ContextIssuePicker.vue'

// The inline picker that attaches a tracker issue to a task or an initiative. It lists the issues
// already imported from the service's repository (loaded on mount), searches the tracker as the
// user types, and offers a pasted URL as a reference. Picking only emits the choice. The search
// waits 300 ms after the last key, so the search stories wait for the result in the play.
const meta = {
  title: 'Board/Components/ContextIssuePicker',
  component: ContextIssuePicker,
  parameters: {
    width: 'panel',
    api: [listAnswer(authServiceIssues), searchAnswer()],
  },
  args: { scopeBlockId: authService.id },
  decorators: [withTrackers(taskSources)],
} satisfies Meta<typeof ContextIssuePicker>
export default meta

type Story = StoryObj<typeof meta>

/** Put the trackers the workspace offers on the tasks store, as its probe would. */
function withTrackers(sources: TaskSourceState[]) {
  return withSeed(() => {
    seedWorkspace()
    seedTaskSources(sources)
  })
}

function listAnswer(body = authServiceIssues) {
  return apiResponse(listTasksContract, { pathPrefix: storyWorkspacePrefix, body })
}

function searchAnswer(results = sessionSearchHits) {
  return apiResponse(searchTasksContract, {
    pathPrefix: storyWorkspacePrefix,
    pathParams: { source: 'github' },
    body: { results },
  })
}

/** GitHub Issues only: the deployment registers one tracker. */
const githubOnly = withTrackers(taskSources.filter((s) => s.source === 'github'))

async function type(canvasElement: HTMLElement, text: string) {
  await userEvent.type(within(canvasElement).getByRole('textbox'), text)
}

/**
 * One tracker, so it is named as text instead of a menu, and the two issues already imported
 * from the Auth Service repository.
 */
export const Default: Story = {
  decorators: [githubOnly],
}

/** Nothing imported and nothing typed: the empty state says what to do. */
export const Empty: Story = {
  decorators: [githubOnly],
  parameters: { api: [listAnswer([]), searchAnswer()] },
}

/**
 * "session" typed: the imported issue that matches, then the search hits with their GitHub
 * status.
 */
export const SearchResults: Story = {
  decorators: [githubOnly],
  play: async ({ canvasElement }) => {
    await type(canvasElement, 'session')
    await within(canvasElement).findByText(/#97/)
  },
}

/**
 * The service has no linked repository, so the search is refused with `repo_not_linked`, and the
 * translated hint replaces the backend's message.
 */
export const SearchNeedsRepo: Story = {
  decorators: [githubOnly],
  parameters: {
    api: [
      listAnswer([]),
      apiRefusal(searchTasksContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { source: 'github' },
        status: 400,
        error: {
          code: 'validation',
          message:
            'This service is not linked to a repository. Link it to a repo before reading its issues.',
          details: { reason: 'repo_not_linked' },
        },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await type(canvasElement, 'session')
    await within(canvasElement).findByText(/isn't linked to a repository/)
  },
}

/** A pasted issue URL from another repository: offered as a reference, since search will not find it. */
export const PastedReference: Story = {
  decorators: [githubOnly],
  parameters: { api: [listAnswer(), searchAnswer([])] },
  play: async ({ canvasElement }) => {
    await type(canvasElement, 'https://github.com/acme/web-app/issues/412')
    await within(canvasElement).findByText(/by reference/)
  },
}

/**
 * GitHub Issues and Jira offered, Linear not connected: the tracker is a menu, which also offers
 * to connect Linear.
 */
export const SeveralTrackers: Story = {
  render: (args) => ({
    components: { ContextIssuePicker },
    setup: () => ({ args }),
    template: '<div class="pb-40"><ContextIssuePicker v-bind="args" /></div>',
  }),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Source/ }))
    await screen.findByText('Connect Linear')
  },
}
