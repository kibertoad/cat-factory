import type { Meta, StoryObj } from '@storybook/vue3'
import type { WorkspaceSnapshot } from '@cat-factory/contracts'
import { authInitiative, boardWith, loginTask, logoutTask } from '~/stories/board.stories.mocks'
import { initiative, initiativeSnapshot } from '~/stories/initiative.stories.mocks'
import { riskPolicy } from '~/stories/policies.stories.mocks'
import { claudeOnlyCatalog } from '~/stories/providers.stories.mocks'
import { execution } from '~/stories/snapshot.stories.mocks'
import { taskFormSnapshot } from '~/stories/taskForm.stories.mocks'
import { seedModelCatalog, seedSnapshot, seedUiMode, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import { useWorkspaceStore } from '~/stores/workspace'
import type { UiMode } from '~/utils/uiMode'
import BlockFocusView from './BlockFocusView.vue'

// One block full screen: the way back to the board, its type and status, and the Run menu, then
// its pipeline run and, beside it, its description, progress and dependencies. An initiative runs
// its planning pipeline from one button. The run mode follows the merge policy: a policy that
// sandboxes the person's role says so, and the advanced tier can ask for a sandbox. The view loads
// the model catalog on open, so the stories seed it loaded. Every run control sends a request no
// story answers.
function focused(
  blockId: string,
  board: WorkspaceSnapshot,
  { mode = 'basic', role }: { mode?: UiMode; role?: 'member' } = {},
) {
  return withSeed(() => {
    seedSnapshot(board)
    seedModelCatalog(claudeOnlyCatalog)
    seedUiMode(mode)
    // The member's permissions are the backend's (`WORKSPACE_ROLE_PERMISSIONS` in kernel).
    if (role) {
      useWorkspaceStore().access = {
        role,
        permissions: ['workspace.read', 'board.write', 'runs.execute'],
      }
    }
    useUiStore().focus(blockId)
  })
}

const running = taskFormSnapshot({
  blocks: boardWith({ ...loginTask, executionId: 'exec_login' }),
  executions: [execution()],
})

const meta = {
  title: 'Board/Components/BlockFocusView',
  component: BlockFocusView,
  render: () => ({
    components: { BlockFocusView },
    template: '<div class="relative h-[640px]"><BlockFocusView /></div>',
  }),
} satisfies Meta<typeof BlockFocusView>
export default meta

type Story = StoryObj<typeof meta>

/** The login task's run at the coder step, with Re-run, the progress and no dependencies. */
export const Default: Story = {
  decorators: [focused(loginTask.id, running)],
}

/** Log out everywhere has not run: the empty pipeline, Run, and its two dependencies. */
export const Empty: Story = {
  decorators: [focused(logoutTask.id, taskFormSnapshot())],
}

/**
 * The initiative: Run planning, and beside it the Run pipeline menu, which the template's comment
 * says an initiative does not get (the menu is the last branch of the dry-run chain, and an
 * initiative takes neither of the branches before it).
 */
export const Initiative: Story = {
  decorators: [focused(authInitiative.id, initiativeSnapshot(initiative()))],
}

/**
 * The merge policy sandboxes runs started by a member: the Dry run badge, and no Re-run pipeline
 * menu, because the badge and the menu are branches of one chain.
 */
export const DryRunForced: Story = {
  decorators: [
    focused(
      loginTask.id,
      taskFormSnapshot({
        blocks: boardWith({ ...loginTask, executionId: 'exec_login' }),
        executions: [execution()],
        riskPolicies: [riskPolicy({ dryRunRoles: ['member'] })],
      }),
      { role: 'member' },
    ),
  ],
}

/**
 * The advanced tier: the Dry run switch, which asks for a sandbox on the next run, and for the
 * same reason no Re-run pipeline menu.
 */
export const Advanced: Story = {
  decorators: [focused(loginTask.id, running, { mode: 'advanced' })],
}
