import type { Meta, StoryObj } from '@storybook/vue3'
import { connectGitLabContract } from '@cat-factory/contracts'
import { userEvent, within } from 'storybook/test'
import { apiRefusal } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { vcsConnectOptions } from '~/stories/vcs.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useGitHubStore } from '~/stores/github'
import GitLabConnect from './GitLabConnect.vue'

// Connect the workspace to GitLab with a personal access token. The backend checks the token with
// GitLab before it stores it, and a refused token shows its reason under the field. The token
// link opens the token page on the GitLab host the deployment names. The token is made up.
const meta = {
  title: 'Setup/Components/GitLabConnect',
  component: GitLabConnect,
  parameters: { width: 'prose' },
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useGitHubStore().connectOptions = vcsConnectOptions
    }),
  ],
} satisfies Meta<typeof GitLabConnect>
export default meta

type Story = StoryObj<typeof meta>

/** The token field, the link to make one, and Connect, disabled until a token is typed. */
export const Default: Story = {}

/**
 * GitLab refused the token. The backend's refusal (`VcsPatConnectionService` in integrations)
 * names the provider by its id, so it reads "gitlab".
 */
export const Failed: Story = {
  parameters: {
    api: [
      apiRefusal(connectGitLabContract, {
        pathPrefix: storyWorkspacePrefix,
        status: 422,
        error: {
          code: 'validation',
          message: 'That gitlab token is invalid or lacks the required access.',
          details: { reason: 'invalid_token' },
        },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByTestId('gitlab-pat-input'), 'glpat-4kQz9vR2xLm7TpW1')
    await userEvent.click(canvas.getByTestId('gitlab-connect-submit'))
    await canvas.findByTestId('gitlab-connect-error')
  },
}
