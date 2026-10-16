import type { Meta, StoryObj } from '@storybook/vue3'
import {
  listGitHubAvailableReposContract,
  listGitHubRepoFilesContract,
} from '@cat-factory/contracts'
import { ref } from 'vue'
import { screen, userEvent, within } from 'storybook/test'
import { contextKey, type PendingContext } from '~/composables/useContextLinking'
import { apiFailure, apiHandler } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { githubProbeApi } from '~/stories/githubApi'
import { githubDocsDescriptor } from '~/stories/integrations.stories.mocks'
import {
  billingMigrations,
  PLATFORM_REPO_ID,
  platformFiles,
} from '~/stories/repoFiles.stories.mocks'
import { repoFilesApi } from '~/stories/repoFilesApi'
import { availableRepos } from '~/stories/vcs.stories.mocks'
import { seedVcs, seedWorkspace, withSeed } from '~/stories/withStores'
import RepoContextDocPicker from './RepoContextDocPicker.vue'

// Attach files from a repository as task context: search for the repository, then search its
// paths or browse its folders, and pick one or more files. A picked file is staged by the caller,
// which passes its key back, so it shows as added and is not offered again. The render keeps the
// picks, so a click shows. The repository search answers with the repos whose `owner/name` holds
// the query; the files are the shared `acme/platform` monorepo's (`repoFiles.stories.mocks.ts`).
// Opening the picker also probes the GitHub connection.
const RUNBOOK_KEY = 'document:github:acme/platform:docs/runbook.md'

const repoSearch = apiHandler(
  listGitHubAvailableReposContract,
  { pathPrefix: storyWorkspacePrefix, pattern: undefined },
  ({ query }) => {
    const q = (query.get('q') ?? '').toLowerCase()
    return availableRepos.filter((r) => `${r.owner}/${r.name}`.includes(q))
  },
)

const meta = {
  title: 'Documents/Components/RepoContextDocPicker',
  component: RepoContextDocPicker,
  args: { source: 'github', icon: githubDocsDescriptor.icon, chosenKeys: [] },
  parameters: { width: 'panel', api: [repoSearch, ...githubProbeApi(), ...repoFilesApi()] },
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedVcs()
    }),
  ],
  render: (args) => ({
    components: { RepoContextDocPicker },
    setup() {
      const chosen = ref<string[]>(args.chosenKeys ?? [])
      function pick(item: PendingContext) {
        chosen.value = [...chosen.value, contextKey(item)]
      }
      return { args, chosen, pick }
    },
    template:
      '<div class="pb-56"><RepoContextDocPicker v-bind="args" :chosen-keys="chosen" @pick="pick" /></div>',
  }),
} satisfies Meta<typeof RepoContextDocPicker>
export default meta

type Story = StoryObj<typeof meta>

/** Search for `acme/platform` and pick it. */
async function pickPlatform(canvasElement: HTMLElement) {
  const input = within(canvasElement).getByRole('combobox')
  await userEvent.click(input)
  await userEvent.type(input, 'plat')
  await userEvent.click(await screen.findByRole('option', { name: /acme\/platform/ }))
}

/** Pick `acme/platform` and type `text` into its path search. */
async function searchFiles(canvasElement: HTMLElement, text: string) {
  await pickPlatform(canvasElement)
  const files = await within(canvasElement).findByPlaceholderText('Search files by path…')
  await userEvent.type(files, text)
}

/** Nothing picked: only the repository search. */
export const Default: Story = {}

/** `acme/platform` picked: the clear button, the two tabs, and the hint to type a path. */
export const RepoSelected: Story = {
  play: async ({ canvasElement }) => pickPlatform(canvasElement),
}

/**
 * "docs": the matching paths. The runbook is already staged, so it is not offered; a click on
 * another file stages it too.
 */
export const FileMatches: Story = {
  args: { chosenKeys: [RUNBOOK_KEY] },
  play: async ({ canvasElement }) => {
    await searchFiles(canvasElement, 'docs')
    await within(canvasElement).findByText('docs/architecture.md')
  },
}

/** "migrations" matches 64 files: the first 50, and a line that says so. */
export const FileMatchesTruncated: Story = {
  parameters: {
    api: [
      repoSearch,
      ...githubProbeApi(),
      ...repoFilesApi([...platformFiles, ...billingMigrations]),
    ],
  },
  play: async ({ canvasElement }) => {
    await searchFiles(canvasElement, 'migrations')
    await within(canvasElement).findByText('packages/billing-api/migrations/0001.sql')
  },
}

/** "terraform" matches no path. */
export const NoFileMatches: Story = {
  play: async ({ canvasElement }) => {
    await searchFiles(canvasElement, 'terraform')
    await within(canvasElement).findByText('No matching files.')
  },
}

/** The file list did not load: the line under the search box says so with the error. */
export const FilesFailed: Story = {
  parameters: {
    api: [
      apiFailure(listGitHubRepoFilesContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { repoGithubId: String(PLATFORM_REPO_ID) },
      }),
      repoSearch,
      ...githubProbeApi(),
      ...repoFilesApi(),
    ],
  },
  play: async ({ canvasElement }) => {
    await pickPlatform(canvasElement)
    await within(canvasElement).findByText(/Couldn't load files/)
  },
}

/** Browse, opened on `docs`: the runbook is already staged and shows as added. */
export const Browse: Story = {
  args: { chosenKeys: [RUNBOOK_KEY] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await pickPlatform(canvasElement)
    await userEvent.click(await canvas.findByRole('button', { name: 'Browse' }))
    await userEvent.click(await canvas.findByRole('button', { name: 'docs' }))
    await canvas.findByText('runbook.md')
  },
}
