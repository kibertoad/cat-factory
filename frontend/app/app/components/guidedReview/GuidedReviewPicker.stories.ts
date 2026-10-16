import type { Meta, StoryObj } from '@storybook/vue3'
import type { GitHubRepo } from '@cat-factory/contracts'
import { fn, screen, userEvent, within } from 'storybook/test'
import { authRepo, gatewayRepo, githubConnection, pullRequests } from '~/stories/vcs.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useGitHubStore } from '~/stores/github'
import GuidedReviewPicker from './GuidedReviewPicker.vue'

// The first screen of a guided review: pick a linked repository, then one of its open pull
// requests from the synced list, or type any number. It reads the repositories and pull requests
// from the GitHub store, which the guided review window loads; the stories seed the store. The
// gateway repository and the pull requests are the shared ones (`vcs.stories.mocks.ts`).
function withRepos(repos: GitHubRepo[]) {
  return withSeed(() => {
    const github = useGitHubStore()
    github.connection = githubConnection
    github.repos = repos
    github.pulls = pullRequests
  })
}

/** Choose acme/auth-service in the repository menu. */
async function chooseAuthService(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByTestId('guided-review-picker-repo'))
  await userEvent.click(await screen.findByRole('option', { name: 'acme/auth-service' }))
}

const meta = {
  title: 'Review/Components/GuidedReviewPicker',
  component: GuidedReviewPicker,
  parameters: { width: 'prose' },
  args: { opening: false, loading: false, onOpen: fn() },
  decorators: [withRepos([authRepo, gatewayRepo])],
} satisfies Meta<typeof GuidedReviewPicker>
export default meta

type Story = StoryObj<typeof meta>

/** The auth service chosen: its two open pull requests, and the number field. */
export const Default: Story = {
  play: async ({ canvasElement }) => chooseAuthService(canvasElement),
}

/** The repositories are loading: two placeholder rows. */
export const Loading: Story = { args: { loading: true } }

/** No repository is linked to the workspace. */
export const Empty: Story = { decorators: [withRepos([])] }

/** A pull request was picked and the review is opening: the list is disabled. */
export const Opening: Story = {
  args: { opening: true },
  play: async ({ canvasElement }) => chooseAuthService(canvasElement),
}
