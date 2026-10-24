import { githubPatCreateUrl } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { withSeed } from '~/stories/withStores'
import { useAuthStore } from '~/stores/auth'
import GitHubPatBanner from './GitHubPatBanner.vue'

// The local mode warning that no GitHub token is configured, so every step that clones, pushes or
// opens a pull request will fail. The button opens GitHub's token page with the scopes ticked,
// at the address the local backend reports. It shows until a token is configured or the user
// dismisses it.
const meta = {
  title: 'Setup/Components/GitHubPatBanner',
  component: GitHubPatBanner,
  decorators: [
    withSeed(() => {
      useAuthStore().localMode = {
        enabled: true,
        githubPatSetupUrl: githubPatCreateUrl('classic', {
          webUrl: 'https://github.com',
          description: 'cat-factory',
        }),
      }
    }),
  ],
} satisfies Meta<typeof GitHubPatBanner>
export default meta

type Story = StoryObj<typeof meta>

/** The warning, the create token button and the hint to set GITHUB_PAT. */
export const Default: Story = {}
