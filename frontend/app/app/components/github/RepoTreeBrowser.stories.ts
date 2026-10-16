import type { Meta, StoryObj } from '@storybook/vue3'
import { listGitHubRepoTreeContract } from '@cat-factory/contracts'
import { ref } from 'vue'
import { userEvent, within } from 'storybook/test'
import { apiFailure, apiPending } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { PLATFORM_REPO_ID } from '~/stories/repoFiles.stories.mocks'
import { repoFilesApi } from '~/stories/repoFilesApi'
import { seedVcs, seedWorkspace, withSeed } from '~/stories/withStores'
import RepoTreeBrowser from './RepoTreeBrowser.vue'

// Browse a repository one folder at a time and pick a path: a folder (a monorepo service's
// directory) or a file (a compose file, a context document). With `multiple` it collects several
// picks from any folder, and paths picked elsewhere show as added. With `newDirName` it picks
// where a new folder goes, and refuses a folder that already holds that name. The render keeps
// the picks, so a click shows.
//
// It lists each folder when it opens it, so the stories answer the tree read per `path`. The
// repo is the shared `acme/platform` monorepo (`repoFiles.stories.mocks.ts`).
const meta = {
  title: 'Setup/Components/RepoTreeBrowser',
  component: RepoTreeBrowser,
  args: { repoGithubId: PLATFORM_REPO_ID },
  parameters: { width: 'panel', api: repoFilesApi() },
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedVcs()
    }),
  ],
  render: (args) => ({
    components: { RepoTreeBrowser },
    setup() {
      const value = ref<string | undefined>(args.modelValue)
      const picks = ref<string[]>(args.selectedPaths ?? [])
      function toggle(path: string) {
        picks.value = picks.value.includes(path)
          ? picks.value.filter((p) => p !== path)
          : [...picks.value, path]
      }
      return { args, value, picks, toggle }
    },
    template:
      '<RepoTreeBrowser v-bind="args" v-model="value" :selected-paths="picks" @toggle="toggle" />',
  }),
} satisfies Meta<typeof RepoTreeBrowser>
export default meta

type Story = StoryObj<typeof meta>

/** The repo root, picking a folder: the three folders, each with Select. Files do not show. */
export const Default: Story = {}

/** The folder read in flight: placeholder rows. */
export const Loading: Story = {
  parameters: {
    api: [
      apiPending(listGitHubRepoTreeContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { repoGithubId: String(PLATFORM_REPO_ID) },
      }),
    ],
  },
}

/** A folder with files only, picking a folder: no subfolders, and Use this folder. */
export const Empty: Story = { args: { startPath: 'packages/shared' } }

/** The read failed: the error toast, and an empty folder. */
export const Error: Story = {
  parameters: {
    api: [
      apiFailure(listGitHubRepoTreeContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { repoGithubId: String(PLATFORM_REPO_ID) },
      }),
    ],
  },
}

/** Opened in `packages`, with `packages/auth` picked: the crumbs, and Selected on it. */
export const Nested: Story = { args: { startPath: 'packages', modelValue: 'packages/auth' } }

/**
 * Several service folders in `packages`: Auth is already on the board, and Billing API is
 * picked. The cart also holds `apps/web`, picked in another folder, which this listing does not
 * show.
 */
export const MultipleDirectories: Story = {
  args: {
    startPath: 'packages',
    multiple: true,
    selectedPaths: ['apps/web', 'packages/billing-api'],
    addedPaths: ['packages/auth'],
  },
}

/** Picking documents: a select-all row over the folder's files, and one file already added. */
export const MultipleFiles: Story = {
  args: {
    mode: 'file',
    startPath: 'docs',
    multiple: true,
    selectedPaths: ['docs/architecture.md'],
    addedPaths: ['docs/runbook.md'],
  },
}

/**
 * Placing a new `notifications` folder: the folders have no Select, and the line under the list
 * spells out the path a pick here makes.
 */
export const PlacingNewDirectory: Story = {
  args: { newDirName: 'notifications' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('button', { name: 'packages' }))
    await canvas.findByText('billing-api')
  },
}

/** Placing a new `auth` folder in `packages`, which already has one: the clash, and no pick. */
export const NameTaken: Story = { args: { newDirName: 'auth', startPath: 'packages' } }
