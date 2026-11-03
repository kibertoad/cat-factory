import { listGitHubAvailableReposContract } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { screen, userEvent, within } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { boardBlocks, logoutTask } from '~/stories/board.stories.mocks'
import { AUTH_REPO_ID } from '~/stories/vcs.stories.mocks'
import { seedBoard, seedVcs, seedWorkspace, withSeed } from '~/stories/withStores'
import { useGitHubStore } from '~/stores/github'
import DocReferenceRepos from './DocReferenceRepos.vue'

// Repositories a document task's writer may read while drafting, as removable chips above a
// server-side repo search. A repo already attached shows in the results but cannot be picked
// again. The inspector shows this only for a document task.
const docTask = { ...logoutTask, taskType: 'document' }

const authReference = {
  repoId: AUTH_REPO_ID,
  owner: 'acme',
  name: 'auth-service',
  defaultBranch: 'main',
}

const meta = {
  title: 'Inspector/Components/DocReferenceRepos',
  component: DocReferenceRepos,
  decorators: [
    withSeed(() => {
      seedBoard(boardBlocks)
      seedWorkspace()
      seedVcs()
    }),
  ],
  parameters: {
    width: 'panel',
    api: [
      apiResponse(listGitHubAvailableReposContract, {
        pathPrefix: storyWorkspacePrefix,
        body: [
          {
            githubId: AUTH_REPO_ID,
            owner: 'acme',
            name: 'auth-service',
            defaultBranch: 'main',
            private: true,
            linked: true,
            isMonorepo: false,
            personal: false,
          },
          {
            githubId: 102,
            owner: 'acme',
            name: 'auth-docs',
            defaultBranch: 'main',
            private: false,
            linked: false,
            isMonorepo: false,
            personal: false,
          },
        ],
      }),
    ],
  },
} satisfies Meta<typeof DocReferenceRepos>
export default meta

type Story = StoryObj<typeof meta>

/** One repo attached. */
export const Default: Story = { args: { block: { ...docTask, referenceRepos: [authReference] } } }

/** Nothing attached: the search alone. */
export const Empty: Story = { args: { block: docTask } }

/** Searching "auth": the attached repo is listed but cannot be picked again. */
export const Searching: Story = {
  args: { block: { ...docTask, referenceRepos: [authReference] } },
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByPlaceholderText(/search/i), 'auth')
    // The results list is teleported to `body`.
    await screen.findByRole('option', { name: 'acme/auth-docs' })
  },
}

/** GitHub is not connected: no search, and a line saying to connect first. */
export const NotConnected: Story = {
  args: { block: { ...docTask, referenceRepos: [authReference] } },
  decorators: [
    withSeed(() => {
      useGitHubStore().connection = null
    }),
  ],
}
