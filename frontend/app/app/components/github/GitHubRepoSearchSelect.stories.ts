import type { Meta, StoryObj } from '@storybook/vue3'
import type { GitHubAvailableRepo } from '@cat-factory/contracts'
import { listGitHubAvailableReposContract } from '@cat-factory/contracts'
import { ref } from 'vue'
import { screen, userEvent, within } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { availableRepos } from '~/stories/vcs.stories.mocks'
import { seedVcs, seedWorkspace, withSeed } from '~/stories/withStores'
import GitHubRepoSearchSelect from './GitHubRepoSearchSelect.vue'

// Pick a repository the App can reach by searching for it. Nothing loads up front: from three
// characters on, the backend filters `owner/name`, a quarter second after the last key. The
// selection stays shown after a later search replaces the list, with a button to clear it. The
// render keeps the value, so a pick shows. Each story answers the search with the repos it shows;
// the backend's filtering is not repeated here.
const meta = {
  title: 'Setup/Components/GitHubRepoSearchSelect',
  component: GitHubRepoSearchSelect,
  parameters: { width: 'panel', api: [reposAre(availableRepos)] },
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedVcs()
    }),
  ],
  render: (args) => ({
    components: { GitHubRepoSearchSelect },
    setup() {
      const value = ref<number | undefined>(args.modelValue)
      return { value }
    },
    template: '<div class="pb-56"><GitHubRepoSearchSelect v-model="value" /></div>',
  }),
} satisfies Meta<typeof GitHubRepoSearchSelect>
export default meta

type Story = StoryObj<typeof meta>

function reposAre(body: GitHubAvailableRepo[]) {
  return apiResponse(listGitHubAvailableReposContract, { pathPrefix: storyWorkspacePrefix, body })
}

async function search(canvasElement: HTMLElement, text: string) {
  const input = within(canvasElement).getByRole('combobox')
  await userEvent.click(input)
  await userEvent.type(input, text)
}

/** Nothing typed and nothing picked. */
export const Default: Story = {}

/** Two characters: the menu asks for one more. */
export const BelowMinChars: Story = {
  play: async ({ canvasElement }) => search(canvasElement, 'ac'),
}

/** "acme": the three repos the App can reach, private ones marked. */
export const Results: Story = {
  play: async ({ canvasElement }) => {
    await search(canvasElement, 'acme')
    await screen.findByRole('option', { name: /api-gateway/ })
  },
}

/** A search with no match says so with the query. */
export const NoMatches: Story = {
  parameters: { api: [reposAre([])] },
  play: async ({ canvasElement }) => {
    await search(canvasElement, 'billing')
    await screen.findByText(/billing/)
  },
}

/** API Gateway picked: its name in the field, and the clear button. */
export const Selected: Story = {
  play: async ({ canvasElement }) => {
    await search(canvasElement, 'acme')
    await userEvent.click(await screen.findByRole('option', { name: /api-gateway/ }))
  },
}
