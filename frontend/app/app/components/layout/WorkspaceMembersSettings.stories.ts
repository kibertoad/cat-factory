import type { Meta, StoryObj } from '@storybook/vue3'
import { screen } from 'storybook/test'
import type { AccountMember, WorkspaceListItem, WorkspaceMember } from '@cat-factory/contracts'
import {
  listAccountMembersContract,
  listInvitationsContract,
  listWorkspaceMembersContract,
} from '@cat-factory/contracts'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID } from '~/stories/workspace'
import {
  accountBoards,
  accountMembers,
  orgAccount,
  signedInUser,
  workspaceMembers,
} from '~/stories/accounts.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useAuthStore } from '~/stores/auth'
import { useWorkspaceStore } from '~/stores/workspace'
import WorkspaceMembersSettings from './WorkspaceMembersSettings.vue'

// Who can see one board, for a board admin: whether the board is open to every account member
// or restricted to its own roster, the roster with a role picker and a remove button per member,
// and a row that adds an account member. The panel loads the roster and the account's members
// when it mounts, so each story answers those reads. The signed-in user is Maya.

function loads(roster: WorkspaceMember[], account: AccountMember[] = accountMembers) {
  return [
    apiResponse(listWorkspaceMembersContract, {
      pathParams: { workspaceId: STORY_WORKSPACE_ID },
      body: roster,
    }),
    apiResponse(listAccountMembersContract, {
      pathParams: { accountId: orgAccount.id },
      body: account,
    }),
    apiResponse(listInvitationsContract, { pathParams: { accountId: orgAccount.id }, body: [] }),
  ]
}

/** The story board's row, as the board list carries it, with `overrides`. */
function boardIs(overrides: Partial<WorkspaceListItem> = {}) {
  return withSeed(() => {
    const workspace = useWorkspaceStore()
    workspace.workspaceId = STORY_WORKSPACE_ID
    workspace.workspaces = [{ ...accountBoards[0]!, ...overrides }]
    useAuthStore().user = signedInUser
  })
}

const meta = {
  title: 'Settings/Components/WorkspaceMembersSettings',
  component: WorkspaceMembersSettings,
  args: { workspaceId: STORY_WORKSPACE_ID },
  decorators: [boardIs()],
  parameters: { width: 'prose', api: loads(workspaceMembers) },
} satisfies Meta<typeof WorkspaceMembersSettings>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Open to every account member: the roster of three, Maya marked as you, and Jonas offered in
 * the add row.
 */
export const Default: Story = {}

/** Restricted to the roster, with the hint that says only these people see the board. */
export const Restricted: Story = { decorators: [boardIs({ accessMode: 'restricted' })] }

/** No one on the roster yet. */
export const Empty: Story = { parameters: { api: loads([]) } }

/** The roster read in flight: three placeholder rows. */
export const Loading: Story = {
  parameters: {
    api: [
      apiPending(listWorkspaceMembersContract, { pathParams: { workspaceId: STORY_WORKSPACE_ID } }),
      ...loads(workspaceMembers).slice(1),
    ],
  },
}

/** The roster read failed: a toast, and the roster says so with a retry instead of a skeleton. */
export const Failed: Story = {
  play: async () => {
    await screen.findByTestId('load-failed-state')
  },
  parameters: {
    api: [
      apiFailure(listWorkspaceMembersContract, { pathParams: { workspaceId: STORY_WORKSPACE_ID } }),
      ...loads(workspaceMembers).slice(1),
    ],
  },
}

/** Every account member is already on the board: the add row is off, with a note. */
export const NoCandidates: Story = {
  parameters: {
    api: loads(
      workspaceMembers,
      accountMembers.filter((member) => member.userId !== 'usr_jonas'),
    ),
  },
}

/** A board that belongs to no account: a note in place of the add row. */
export const NoAccount: Story = {
  decorators: [boardIs({ accountId: null })],
  parameters: { api: loads(workspaceMembers).slice(0, 1) },
}
