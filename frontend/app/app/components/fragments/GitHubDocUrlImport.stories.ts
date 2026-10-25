import type { Meta, StoryObj } from '@storybook/vue3'
import { listGitHubAvailableReposContract } from '@cat-factory/contracts'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { availableRepos } from '~/stories/vcs.stories.mocks'
import { seedVcs, seedWorkspace, withSeed } from '~/stories/withStores'
import GitHubDocUrlImport from './GitHubDocUrlImport.vue'

// Paste a repository file or folder URL to start linking documents as fragments, without
// searching for the repository first. The URL is read in the browser, and the repository is
// looked up by its exact owner and name among the repositories the connection can reach. A found
// repository is emitted to the library, which opens it at the path; what goes wrong shows under
// the field. Default types a URL; the verdict stories also click Find, and answer the lookup.
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

const docsUrl = 'https://github.com/acme/platform/tree/trunk/docs'

async function find(canvasElement: HTMLElement, url: string) {
  const canvas = within(canvasElement)
  await userEvent.type(canvas.getByRole('textbox'), url)
  await userEvent.click(canvas.getByRole('button', { name: 'Find' }))
  return canvas
}

/** A folder URL pasted, not looked up yet: Find is on. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByRole('textbox'), docsUrl)
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Find' })).toBeEnabled())
  },
}

/** Nothing pasted: Find is off. */
export const Empty: Story = {}

/** A URL that names no repository (an owner only): the line says so, and nothing is looked up. */
export const Invalid: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await find(canvasElement, 'https://github.com/acme')
    await canvas.findByText("This doesn't look like a repository file or folder URL.")
  },
}

/** A repository the connection cannot reach: the line names it. */
export const NotFound: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await find(
      canvasElement,
      'https://github.com/acme/handbook/tree/main/engineering',
    )
    await canvas.findByText(/No accessible repository matches acme\/handbook/)
  },
}

/** The lookup in flight: Find spins. */
export const Resolving: Story = {
  parameters: {
    api: [apiPending(listGitHubAvailableReposContract, { pathPrefix: storyWorkspacePrefix })],
  },
  play: async ({ canvasElement }) => {
    const canvas = await find(canvasElement, docsUrl)
    // The URL stays in the field, so Find is off only while it loads.
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Find' })).toBeDisabled())
  },
}

/** The lookup failed: a translated line, with the backend's message behind "Show details". */
export const RequestFailed: Story = {
  parameters: {
    api: [apiFailure(listGitHubAvailableReposContract, { pathPrefix: storyWorkspacePrefix })],
  },
  play: async ({ canvasElement }) => {
    const canvas = await find(canvasElement, docsUrl)
    await canvas.findByTestId('fragment-url-import-error')
  },
}
