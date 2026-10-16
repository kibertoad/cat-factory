import type { Meta, StoryObj } from '@storybook/vue3'
import {
  listGitHubAvailableReposContract,
  listGitHubBranchesContract,
  listGitHubInstallationsContract,
  listGitHubReposContract,
  type GitHubConnection,
  type VcsConnectOption,
} from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { githubLoadApi } from '~/stories/githubApi'
import {
  AUTH_REPO_ID,
  authBranches,
  authRepo,
  availableRepos,
  gatewayRepo,
  githubConnection,
  githubInstallations,
  githubIssues,
  pullRequests,
  vcsConnectOptions,
} from '~/stories/vcs.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useGitHubStore } from '~/stores/github'
import { useUiStore } from '~/stores/ui'
import GitHubPanel from './GitHubPanel.vue'

// The board's repository host window. Connected: the account and the connection, resync and
// disconnect, and three tabs of what the backend keeps in sync (the repositories linked to the
// board, their pull requests and their issues). Not connected: the ways the deployment offers to
// connect one. The window does not probe the connection itself: the shell has done that when the
// board opened, so each story seeds what the probe found. When connected it loads the three
// lists as it opens, so each story answers those reads. The board links Auth Service's and API
// Gateway's repositories. The tabs, rows and buttons are clicked, as a person does.
const pathPrefix = storyWorkspacePrefix
const linked = [authRepo, gatewayRepo]

/** What the App can reach, with the two the board links ticked. */
const reachable = availableRepos.map((r) => ({ ...r, linked: r.name !== 'platform' }))

const load = githubLoadApi({ repos: linked, pulls: pullRequests, issues: githubIssues })

/** The window opened over a board whose probe found `connection` and `connectOptions`. */
function opened(
  connection: GitHubConnection | null = githubConnection,
  connectOptions: VcsConnectOption[] = [],
) {
  return withSeed(() => {
    seedWorkspace()
    const github = useGitHubStore()
    github.available = true
    github.connection = connection
    github.connectOptions = connectOptions
    useUiStore().openGitHub()
  })
}

async function click(name: string | RegExp) {
  await userEvent.click(await screen.findByRole('button', { name }))
}

const meta = {
  title: 'Settings/Components/GitHubPanel',
  component: GitHubPanel,
  decorators: [opened()],
  parameters: { api: load },
} satisfies Meta<typeof GitHubPanel>
export default meta

type Story = StoryObj<typeof meta>

/** Connected to the acme organisation: the two linked repositories and the branch protection check. */
export const Default: Story = {}

/** The lists still loading: placeholder rows. */
export const Loading: Story = {
  parameters: {
    api: [apiPending(listGitHubReposContract, { pathPrefix }), ...load],
  },
}

/** Connected, with no repository linked to the board yet. */
export const Empty: Story = {
  parameters: { api: githubLoadApi({ repos: [] }) },
}

/** Manage repositories opened: what the App can reach, with the board's two ticked. */
export const ManageRepos: Story = {
  parameters: {
    api: [...load, apiResponse(listGitHubAvailableReposContract, { pathPrefix, body: reachable })],
  },
  play: () => click('Manage repos'),
}

/** Auth Service's repository opened: its branches, two protected, and the new branch form. */
export const RepoExpanded: Story = {
  parameters: {
    api: [
      ...load,
      apiResponse(listGitHubBranchesContract, {
        pathPrefix,
        pathParams: { repoGithubId: String(AUTH_REPO_ID) },
        body: authBranches,
      }),
    ],
  },
  play: () => click(/acme\/auth-service/),
}

/** The pull requests tab: three open, one merged, each with its branches. */
export const PullRequests: Story = {
  play: () => click('Pull requests'),
}

/** The issues tab: three open, one closed, with their labels. */
export const Issues: Story = {
  play: () => click('Issues'),
}

const gitlabConnection: GitHubConnection = {
  ...githubConnection,
  provider: 'gitlab',
  method: 'pat',
  accountLogin: 'acme-platform',
  webUrl: 'https://gitlab.acme.dev',
}

/** A GitLab group connected with a token, on the merge requests tab: GitLab's name and nouns (merge requests). */
export const GitLabConnection: Story = {
  decorators: [opened(gitlabConnection)],
  play: () => click('Merge requests'),
}

/** Nothing connected, on a deployment that offers the GitHub App and GitLab tokens. */
export const NotConnected: Story = {
  decorators: [opened(null, vcsConnectOptions)],
  parameters: {
    api: [
      apiResponse(listGitHubInstallationsContract, {
        pathPrefix,
        body: { installations: githubInstallations },
      }),
    ],
  },
}
