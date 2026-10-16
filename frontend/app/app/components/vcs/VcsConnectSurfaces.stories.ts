import type { Meta, StoryObj } from '@storybook/vue3'
import type { VcsConnectOption } from '@cat-factory/contracts'
import { listGitHubInstallationsContract } from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { githubInstallations, vcsConnectOptions } from '~/stories/vcs.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useGitHubStore } from '~/stores/github'
import { useWorkspaceStore } from '~/stores/workspace'
import VcsConnectSurfaces from './VcsConnectSurfaces.vue'

// The ways this deployment lets a workspace connect a repository host: the GitHub App picker, the
// GitLab token field, both, or neither. The deployment's connect options decide which. Connecting
// needs `integrations.manage`, so anyone without it reads who can connect instead. The GitHub
// picker loads the App's installations, so every story answers that read.
const github = vcsConnectOptions.filter((o) => o.provider === 'github')
const gitlab = vcsConnectOptions.filter((o) => o.provider === 'gitlab')

function offering(options: VcsConnectOption[]) {
  return withSeed(() => {
    seedWorkspace()
    useGitHubStore().connectOptions = options
  })
}

const meta = {
  title: 'Setup/Components/VcsConnectSurfaces',
  component: VcsConnectSurfaces,
  args: { appIntro: 'Pick the GitHub account whose repositories this workspace works on.' },
  parameters: {
    width: 'prose',
    api: [
      apiResponse(listGitHubInstallationsContract, {
        pathPrefix: storyWorkspacePrefix,
        body: { installations: githubInstallations },
      }),
    ],
  },
  decorators: [offering(github)],
} satisfies Meta<typeof VcsConnectSurfaces>
export default meta

type Story = StoryObj<typeof meta>

/** A GitHub App deployment: the intro and the installation picker. */
export const Default: Story = {}

/** A GitLab-only deployment: the token field, and no intro, which is for the App picker. */
export const GitLabOnly: Story = { decorators: [offering(gitlab)] }

/** Both: the App picker, then the token field. */
export const Both: Story = { decorators: [offering(vcsConnectOptions)] }

/** The deployment offers neither, or its options could not be read: a line says so. */
export const Empty: Story = { decorators: [offering([])] }

/** A member, who may not connect: a line names who can. */
export const AdminRequired: Story = {
  decorators: [
    withSeed(() => {
      useWorkspaceStore().access = {
        role: 'member',
        permissions: ['workspace.read', 'board.write', 'runs.execute'],
      }
    }),
  ],
}
