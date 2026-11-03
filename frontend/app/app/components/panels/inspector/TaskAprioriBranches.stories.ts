import { listGitHubBranchesContract } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { boardBlocks, loginTask } from '~/stories/board.stories.mocks'
import { AUTH_REPO_ID, authBranches } from '~/stories/vcs.stories.mocks'
import { seedBoard, seedVcs, seedWorkspace, withSeed } from '~/stories/withStores'
import { useGitHubStore } from '~/stores/github'
import TaskAprioriBranches from './TaskAprioriBranches.vue'

// Existing branches of the task's repo handed to the run: a `reference` branch the agents may only
// read, or one `working` branch the run builds inside. The picker lists the repo's branches, which
// the panel loads itself. A working branch that is protected gets a warning; on a task that spans
// more services, or once a PR exists, the working slot is locked and the hint says why. A task
// whose service has no repo renders nothing, so there is no story for it.
const meta = {
  title: 'Inspector/Components/TaskAprioriBranches',
  component: TaskAprioriBranches,
  decorators: [
    withSeed(() => {
      seedBoard(boardBlocks)
      seedWorkspace()
      seedVcs()
    }),
  ],
  parameters: {
    width: 'panel',
    api: [
      apiResponse(listGitHubBranchesContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { repoGithubId: String(AUTH_REPO_ID) },
        body: authBranches,
      }),
    ],
  },
} satisfies Meta<typeof TaskAprioriBranches>
export default meta

type Story = StoryObj<typeof meta>

/** One branch to read, one to build in. */
export const Default: Story = {
  args: {
    block: {
      ...loginTask,
      aprioriBranches: [
        { name: 'spike/refresh-lock', mode: 'reference' },
        { name: 'feat/logout-everywhere', mode: 'working' },
      ],
    },
  },
}

/** Nothing attached yet: the picker alone. */
export const Empty: Story = { args: { block: loginTask } }

/** The working branch is protected, so a push to it is likely to be refused. */
export const ProtectedWorking: Story = {
  args: { block: { ...loginTask, aprioriBranches: [{ name: 'release', mode: 'working' }] } },
}

/** A PR exists, so the working branch can no longer be changed or removed. */
export const FrozenByPullRequest: Story = {
  args: {
    block: {
      ...loginTask,
      aprioriBranches: [{ name: 'feat/logout-everywhere', mode: 'working' }],
      pullRequest: { url: 'https://example.invalid/acme/auth-service/pull/42', number: 42 },
    },
  },
}

/** The task spans another service, so a working branch shows as a reference one. */
export const MultiRepo: Story = {
  args: {
    block: {
      ...loginTask,
      involvedServiceIds: ['svc_gateway'],
      aprioriBranches: [{ name: 'feat/logout-everywhere', mode: 'working' }],
    },
  },
}

/** GitHub is not connected: no picker, and a line saying to connect first. */
export const NotConnected: Story = {
  args: {
    block: { ...loginTask, aprioriBranches: [{ name: 'spike/refresh-lock', mode: 'reference' }] },
  },
  decorators: [
    withSeed(() => {
      useGitHubStore().connection = null
    }),
  ],
}
