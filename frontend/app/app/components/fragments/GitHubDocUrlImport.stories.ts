import type { Meta, StoryObj } from '@storybook/vue3'
import { listGitHubAvailableReposContract } from '@cat-factory/contracts'
import { fn, userEvent, within } from 'storybook/test'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { availableRepos } from '~/stories/vcs.stories.mocks'
import { seedVcs, seedWorkspace, withSeed } from '~/stories/withStores'
import GitHubDocUrlImport from './GitHubDocUrlImport.vue'

// Paste a repository file or folder URL to start linking documents as fragments, without
// searching for the repository first. The URL is read in the browser, and the repository is
// looked up by its exact owner and name among the repositories the connection can reach. A found
// repository is emitted to the library, which opens it at the path; what goes wrong shows under
// the field. The verdict stories type a URL and click Find, and answer the lookup.
const meta = {
  title: 'Settings/Components/GitHubDocUrlImport',
  component: GitHubDocUrlImport,
  args: { onResolved: fn() },
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedVcs()
    }),
  ],
  parameters: {
    width: 'prose',
    api: [
      apiResponse(listGitHubAvailableReposContract, {
        pathPrefix: storyWorkspacePrefix,
        body: availableRepos,
      }),
    ],
  },
} satisfies Meta<typeof GitHubDocUrlImport>
export default meta

type Story = StoryObj<typeof meta>

async function find(canvasElement: HTMLElement, url: string) {
  const canvas = within(canvasElement)
  await userEvent.type(canvas.getByRole('textbox'), url)
  await userEvent.click(canvas.getByRole('button', { name: 'Find' }))
}

/** Nothing pasted: Find is off. */
export const Default: Story = {}

/** A URL that names no repository (an owner only): the line says so, and nothing is looked up. */
export const Invalid: Story = {
  play: async ({ canvasElement }) => find(canvasElement, 'https://github.com/acme'),
}

/** A repository the connection cannot reach: the line names it. */
export const NotFound: Story = {
  play: async ({ canvasElement }) =>
    find(canvasElement, 'https://github.com/acme/handbook/tree/main/engineering'),
}

/** The lookup in flight: Find spins. */
export const Resolving: Story = {
  parameters: {
    api: [apiPending(listGitHubAvailableReposContract, { pathPrefix: storyWorkspacePrefix })],
  },
  play: async ({ canvasElement }) =>
    find(canvasElement, 'https://github.com/acme/platform/tree/trunk/docs'),
}

/** The lookup failed: the line shows the backend's message as it came. */
export const RequestFailed: Story = {
  parameters: {
    api: [apiFailure(listGitHubAvailableReposContract, { pathPrefix: storyWorkspacePrefix })],
  },
  play: async ({ canvasElement }) =>
    find(canvasElement, 'https://github.com/acme/platform/tree/trunk/docs'),
}
