import type { Meta, StoryObj } from '@storybook/vue3'
import {
  addServiceFromRepoContract,
  getWorkspaceContract,
  listGitHubInstallationsContract,
  listGitHubAvailableReposContract,
  type GitHubAvailableRepo,
  type GitHubConnection,
  type Service,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { screen, userEvent } from 'storybook/test'
import { apiHandler, apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID, storyWorkspacePrefix } from '~/stories/workspace'
import { block } from '~/stories/block.stories.mocks'
import { boardBlocks } from '~/stories/board.stories.mocks'
import { githubLoadApi } from '~/stories/githubApi'
import { inspectorApi } from '~/stories/inspectorApi'
import { PLATFORM_REPO_ID } from '~/stories/repoFiles.stories.mocks'
import { repoFilesApi } from '~/stories/repoFilesApi'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import {
  authServiceRow,
  availableRepos,
  githubConnection,
  githubInstallations,
  vcsConnectOptions,
} from '~/stories/vcs.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { useServicesStore } from '~/stores/services'
import { useUiStore } from '~/stores/ui'
import AddServiceFromRepoModal from './AddServiceFromRepoModal.vue'

// The window that adds a service from a repository the workspace's connection can reach, with no
// bootstrap run. The person searches for the repository (three characters at least, searched on
// the server), picks it and its role, and adds it; the new service can then be set up in place. A
// monorepo instead adds one service per directory picked from its tree. The connection is the
// shared `acme` App installation. Auth Service's repository is already on this board, and
// `packages/shared` of the platform monorepo already backs a service elsewhere in the account.
// The search and the picks are typed and clicked, as a person does.
//
// MonorepoFrontendMark leaves the frontend select closed: its none item has the value '', and
// Reka's SelectItem throws for an empty value when the menu opens, so an open select shows
// Storybook's error display.
const pathPrefix = storyWorkspacePrefix

/** A repository the App can see that is not on any board yet, for the whole-repo add. */
const notificationsRepo: GitHubAvailableRepo = {
  githubId: 104,
  owner: 'acme',
  name: 'notifications',
  defaultBranch: 'main',
  private: false,
  linked: false,
  isMonorepo: false,
  personal: false,
}

/** A repository only the signed-in user's own token reaches, not the workspace App. */
const personalRepo: GitHubAvailableRepo = {
  githubId: 105,
  owner: 'acme',
  name: 'auth-load-tests',
  defaultBranch: 'main',
  private: true,
  linked: false,
  isMonorepo: false,
  personal: true,
}

const repos = [...availableRepos, notificationsRepo, personalRepo]

/** The shared package of the platform monorepo, a service on another board of the account. */
const sharedPackageRow: Service = {
  id: 'service_shared',
  accountId: null,
  frameBlockId: 'svc_shared',
  installationId: 9001,
  repoGithubId: PLATFORM_REPO_ID,
  directory: 'packages/shared',
  createdAt: Date.UTC(2026, 8, 20),
}

/** The repository search, matched on `owner/name` as the backend matches it. */
function repoSearchApi(): HttpHandler {
  return apiHandler(
    listGitHubAvailableReposContract,
    { pathPrefix, pattern: undefined },
    ({ query }) => {
      const q = (query.get('q') ?? '').toLowerCase()
      return repos.filter((r) => `${r.owner}/${r.name}`.includes(q))
    },
  )
}

function opened() {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(boardBlocks)
    useServicesStore().hydrate(
      [
        {
          workspaceId: STORY_WORKSPACE_ID,
          serviceId: authServiceRow.id,
          position: { x: 0, y: 0 },
          createdAt: authServiceRow.createdAt,
        },
      ],
      [authServiceRow, sharedPackageRow],
    )
    useUiStore().openAddService()
  })
}

async function search(text: string) {
  await userEvent.type(
    await screen.findByPlaceholderText('Search repositories by owner or name…'),
    text,
  )
}

async function pick(repo: GitHubAvailableRepo) {
  await search(repo.name)
  await userEvent.click(
    await screen.findByRole('option', { name: new RegExp(`${repo.owner}/${repo.name}`) }),
  )
}

/**
 * Open `packages` in the platform tree and select its first `count` directories (`auth`, then
 * `billing-api`; `shared` is already added). Each row's button is named only "Select", and a
 * picked one turns to "Selected", so the first "Select" left is always the next row.
 */
async function selectPackages(count: number) {
  await userEvent.click(await screen.findByRole('button', { name: 'packages' }))
  for (let i = 0; i < count; i++) {
    const [next] = await screen.findAllByRole('button', { name: 'Select' })
    await userEvent.click(next!)
  }
}

const meta = {
  title: 'Board/Components/AddServiceFromRepoModal',
  component: AddServiceFromRepoModal,
  decorators: [opened()],
  parameters: { api: [...githubLoadApi(), repoSearchApi(), ...repoFilesApi()] },
} satisfies Meta<typeof AddServiceFromRepoModal>
export default meta

type Story = StoryObj<typeof meta>

/** Opened on the App connection: the search asks for three characters, and the App can be given access to more. */
export const Default: Story = {
  play: async () => {
    await userEvent.click(
      await screen.findByPlaceholderText('Search repositories by owner or name…'),
    )
  },
}

/**
 * A search for "acme": each repository with what sets it apart (private, a monorepo, reached only
 * through the user's own token), and Auth Service's repository disabled, as it is on this board.
 */
export const SearchResults: Story = {
  play: async () => {
    await search('acme')
    await screen.findByRole('option', { name: /acme\/notifications/ })
  },
}

/** A whole repository picked: its role, the monorepo switch off, and Add service ready. */
export const RepoSelected: Story = {
  play: () => pick(notificationsRepo),
}

const platformRepo = availableRepos.find((r) => r.githubId === PLATFORM_REPO_ID)!

/**
 * The platform monorepo picked: its tree, `shared` marked as already added, and `auth` in the
 * list of services to add.
 */
export const Monorepo: Story = {
  play: async () => {
    await pick(platformRepo)
    await selectPackages(1)
  },
}

/** Two directories picked as backend services, so one can be marked the frontend for the other. */
export const MonorepoFrontendMark: Story = {
  play: async () => {
    await pick(platformRepo)
    await selectPackages(2)
  },
}

const notificationsFrame = block({
  id: 'svc_notifications',
  title: 'notifications',
  level: 'frame',
  parentId: null,
  description: 'Sends the account e-mails and push notifications.',
  position: { x: 900, y: 0 },
  status: 'ready',
  progress: 0,
})

/**
 * The notifications repository added as a service: the window stays open on its test
 * infrastructure and its best-practice fragments, the inspector's own controls.
 */
export const Added: Story = {
  parameters: {
    api: [
      ...inspectorApi(),
      repoSearchApi(),
      apiResponse(addServiceFromRepoContract, { pathPrefix, body: notificationsFrame }),
      apiResponse(getWorkspaceContract, {
        pathParams: { workspaceId: STORY_WORKSPACE_ID },
        body: snapshot({ blocks: [...boardBlocks, notificationsFrame] }),
      }),
    ],
  },
  play: async () => {
    await pick(notificationsRepo)
    await userEvent.click(await screen.findByTestId('add-service-submit'))
    await screen.findByText(/notifications added/)
  },
}

/** No repository host bound to the workspace yet: the ways the deployment offers to connect one. */
export const NotConnected: Story = {
  parameters: {
    api: [
      ...githubLoadApi({ connected: false, connectOptions: vcsConnectOptions }),
      apiResponse(listGitHubInstallationsContract, {
        pathPrefix,
        body: { installations: githubInstallations },
      }),
    ],
  },
}

const tokenConnection: GitHubConnection = { ...githubConnection, method: 'pat' }

/**
 * Connected with a personal access token: the hint points at the token's scope, and there is no
 * App to give access to.
 */
export const TokenConnection: Story = {
  parameters: {
    api: [...githubLoadApi({ connection: tokenConnection }), repoSearchApi()],
  },
}
