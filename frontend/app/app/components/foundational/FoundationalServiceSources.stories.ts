import type { Meta, StoryObj } from '@storybook/vue3'
import type { GitHubAvailableRepo } from '@cat-factory/contracts'
import {
  listGitHubAvailableReposContract,
  listGitHubRepoTreeContract,
} from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiHandler, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { orgAccount } from '~/stories/accounts.stories.mocks'
import { foundationalSources } from '~/stories/foundational.stories.mocks'
import { availableRepos } from '~/stories/vcs.stories.mocks'
import { seedFoundationalCatalog, seedVcs, withSeed } from '~/stories/withStores'
import { useGitHubStore } from '~/stores/github'
import FoundationalServiceSources from './FoundationalServiceSources.vue'

// The repositories a tier syncs its foundational services from, and the form that links one. A
// link takes one of three shapes: a folder of services (each subfolder with a service.md), one
// folder of contracts for one named service, or a list of files for one named service. With the
// GitHub App connected the form searches a repository and browses it; without it, the owner,
// name and path are typed. The stories seed the account's sources as its manager would load them.
const meta = {
  title: 'Settings/Components/FoundationalServiceSources',
  component: FoundationalServiceSources,
  args: { kind: 'account', ownerId: orgAccount.id },
  decorators: [withSources()],
  parameters: { width: 'prose' },
} satisfies Meta<typeof FoundationalServiceSources>
export default meta

type Story = StoryObj<typeof meta>

/** The account's sources, with GitHub connected unless `github` is false. */
function withSources(
  options: { sources?: typeof foundationalSources; github?: boolean; extra?: object } = {},
) {
  return withSeed(() => {
    seedFoundationalCatalog(
      {
        sources: options.sources ?? foundationalSources,
        sourcesAvailable: true,
        ...options.extra,
      },
      orgAccount.id,
    )
    // The story's own decorator runs after the meta's, so it undoes the meta's connection.
    if (options.github === false) {
      useGitHubStore().connection = null
      return
    }
    seedVcs()
    useGitHubStore().available = true
  })
}

/**
 * A folder of services, synced, and a billing API linked by its one file and never synced; the
 * link form searches a repository.
 */
export const Default: Story = {}

/** Nothing linked yet. */
export const Empty: Story = { decorators: [withSources({ sources: [] })] }

/** The last check found new commits on the folder of services: a Changes badge. */
export const ChangesAvailable: Story = {
  decorators: [withSources({ extra: { sourceChanges: { fss_platform_services: true } } })],
}

/** The deployment has no source-control integration: a note in place of the link form. */
export const GitHubRequired: Story = {
  decorators: [withSources({ extra: { sourcesAvailable: false } })],
}

/** GitHub is not connected on this board: the owner, name and path are typed. */
export const ManualEntry: Story = { decorators: [withSources({ github: false })] }

/**
 * One folder for one service: its hint, the subfolders switch, and the fields that name the
 * service.
 */
export const FolderMode: Story = {
  play: async () => {
    await userEvent.click(
      await screen.findByRole('radio', { name: 'Whole folder of contracts, one service' }),
    )
  },
}

const platformServices: GitHubAvailableRepo = {
  ...availableRepos[1]!,
  githubId: 210,
  name: 'platform-services',
}

/** A repository picked: its top folder, ready to browse to the folder that holds the services. */
export const RepoPicked: Story = {
  parameters: {
    api: [
      apiResponse(listGitHubAvailableReposContract, {
        pathPrefix: storyWorkspacePrefix,
        body: [platformServices],
      }),
      apiHandler(
        listGitHubRepoTreeContract,
        { pathPrefix: storyWorkspacePrefix, pattern: { repoGithubId: ':repoGithubId' } },
        () => [
          { path: 'services', name: 'services', type: 'dir' },
          { path: 'docs', name: 'docs', type: 'dir' },
          { path: 'README.md', name: 'README.md', type: 'file' },
        ],
      ),
    ],
  },
  play: async () => {
    const search = await screen.findByRole('combobox')
    await userEvent.click(search)
    await userEvent.type(search, 'platform')
    await userEvent.click(await screen.findByRole('option', { name: /acme\/platform-services/ }))
    await screen.findByText('services')
  },
}
