import type { Meta, StoryObj } from '@storybook/vue3'
import type { GitHubInstallationOption } from '@cat-factory/contracts'
import { listGitHubInstallationsContract } from '@cat-factory/contracts'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { githubInstallations } from '~/stories/vcs.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import GitHubConnect from './GitHubConnect.vue'

// Connect the workspace to a GitHub App installation: pick one the App is already on, install the
// App, or type an installation id. It loads the installations when it opens, so each story
// answers that read. An installation linked to another workspace says so and has no button.
// Connect and install send requests no story answers.
const meta = {
  title: 'Setup/Components/GitHubConnect',
  component: GitHubConnect,
  parameters: { width: 'prose', api: [installationsAre(githubInstallations)] },
  decorators: [withSeed(seedWorkspace)],
} satisfies Meta<typeof GitHubConnect>
export default meta

type Story = StoryObj<typeof meta>

function installationsAre(installations: GitHubInstallationOption[]) {
  return apiResponse(listGitHubInstallationsContract, {
    pathPrefix: storyWorkspacePrefix,
    body: { installations },
  })
}

/** The Acme org, ready to connect, and a personal account in use by another workspace. */
export const Default: Story = {}

/** The App is on no account yet: install it, or connect by id. */
export const Empty: Story = { parameters: { api: [installationsAre([])] } }

/** The list in flight: two placeholder rows. */
export const Loading: Story = {
  parameters: {
    api: [apiPending(listGitHubInstallationsContract, { pathPrefix: storyWorkspacePrefix })],
  },
}

/** The list failed: the error toast, and the empty list under it. */
export const Error: Story = {
  parameters: {
    api: [apiFailure(listGitHubInstallationsContract, { pathPrefix: storyWorkspacePrefix })],
  },
}
