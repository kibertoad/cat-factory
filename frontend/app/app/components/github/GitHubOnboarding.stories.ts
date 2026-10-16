import type { Meta, StoryObj } from '@storybook/vue3'
import type { VcsConnectOption } from '@cat-factory/contracts'
import { listGitHubInstallationsContract } from '@cat-factory/contracts'
import { accountBoards, accounts, orgAccount, signedInUser } from '~/stories/accounts.stories.mocks'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { githubInstallations, vcsConnectOptions } from '~/stories/vcs.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useAccountsStore } from '~/stores/accounts'
import { useAuthStore } from '~/stores/auth'
import { useGitHubStore } from '~/stores/github'
import { useWorkspaceStore } from '~/stores/workspace'
import GitHubOnboarding from './GitHubOnboarding.vue'

// The page that replaces the board while the workspace has no repository host connected. It
// shows the connect ways the deployment offers, a board switcher to go to another board, and,
// with sign-in on, who is signed in and Sign out. A deployment with one provider names it in the
// title. The GitHub picker loads the App's installations, so every story answers that read.
function offering(options: VcsConnectOption[]) {
  return withSeed(() => {
    seedWorkspace()
    useGitHubStore().connectOptions = options
    const accountsStore = useAccountsStore()
    accountsStore.accounts = accounts
    accountsStore.activeAccountId = orgAccount.id
    useWorkspaceStore().workspaces = accountBoards
  })
}

const meta = {
  title: 'Setup/Components/GitHubOnboarding',
  component: GitHubOnboarding,
  parameters: {
    layout: 'fullscreen',
    api: [
      apiResponse(listGitHubInstallationsContract, {
        pathPrefix: storyWorkspacePrefix,
        body: { installations: githubInstallations },
      }),
    ],
  },
  decorators: [offering(vcsConnectOptions.filter((o) => o.provider === 'github'))],
  render: (args) => ({
    components: { GitHubOnboarding },
    setup: () => ({ args }),
    template: '<div class="h-screen"><GitHubOnboarding v-bind="args" /></div>',
  }),
} satisfies Meta<typeof GitHubOnboarding>
export default meta

type Story = StoryObj<typeof meta>

/** GitHub only: the title names GitHub, and the installation picker. */
export const Default: Story = {}

/** GitHub and GitLab: a title that names no provider, the App picker and the token field. */
export const SeveralProviders: Story = { decorators: [offering(vcsConnectOptions)] }

/** Sign-in on: the signed-in login and Sign out at the foot. */
export const SignedIn: Story = {
  decorators: [
    withSeed(() => {
      const auth = useAuthStore()
      auth.required = true
      auth.user = signedInUser
    }),
  ],
}
