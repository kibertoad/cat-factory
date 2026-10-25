import type { Meta, StoryObj } from '@storybook/vue3'
import { expect, within } from 'storybook/test'
import type { WorkspaceSnapshot } from '@cat-factory/contracts'
import { authInitiative, boardWith, loginTask, logoutTask } from '~/stories/board.stories.mocks'
import { initiative, initiativeSnapshot } from '~/stories/initiative.stories.mocks'
import { riskPolicy } from '~/stories/policies.stories.mocks'
import { claudeOnlyCatalog } from '~/stories/providers.stories.mocks'
import { failure } from '~/stories/pipelineStep.stories.mocks'
import { execution } from '~/stories/snapshot.stories.mocks'
import { taskFormSnapshot } from '~/stories/taskForm.stories.mocks'
import {
  seedMember,
  seedModelCatalog,
  seedSnapshot,
  seedUiMode,
  withSeed,
} from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import type { UiMode } from '~/utils/uiMode'
import BlockFocusView from './BlockFocusView.vue'

// One block full screen: the way back to the board, its type and status, and the Run menu, then
// its pipeline run and, beside it, its description, progress and dependencies. A failed run shows
// the failure block between the run's summary and its steps. An initiative runs
// its planning pipeline from one button. The run mode follows the merge policy: a policy that
// sandboxes the person's role says so, and the advanced tier can ask for a sandbox. The view loads
// the model catalog on open, so the stories seed it loaded. Every run control sends a request no
// story answers.
function focused(
  blockId: string,
  board: WorkspaceSnapshot,
  { mode = 'basic', member = false }: { mode?: UiMode; member?: boolean } = {},
) {
  return withSeed(() => {
    seedSnapshot(board)
    seedModelCatalog(claudeOnlyCatalog)
    seedUiMode(mode)
    if (member) seedMember()
    useUiStore().focus(blockId)
  })
}

const running = taskFormSnapshot({
  blocks: boardWith({ ...loginTask, executionId: 'exec_login' }),
  executions: [execution()],
})

const meta = {
  title: 'Board/Pages/BlockFocusView',
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

/** The initiative: Run planning, and no Run pipeline menu, because only a task picks its pipeline. */
export const Initiative: Story = {
  decorators: [focused(authInitiative.id, initiativeSnapshot(initiative()))],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByTestId('focus-run-planning')).toBeVisible()
    await expect(canvas.queryByTestId('focus-run-pipeline')).toBeNull()
  },
}

/** The merge policy sandboxes runs started by a member: the Dry run badge beside Re-run pipeline. */
export const DryRunForced: Story = {
  decorators: [
    focused(
      loginTask.id,
      taskFormSnapshot({
        blocks: boardWith({ ...loginTask, executionId: 'exec_login' }),
        executions: [execution()],
        riskPolicies: [riskPolicy({ dryRunRoles: ['member'] })],
      }),
      { member: true },
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByTestId('focus-dry-run-forced')).toBeVisible()
    await expect(canvas.getByTestId('focus-run-pipeline')).toBeVisible()
  },
}

/**
 * The advanced tier: the Dry run switch, which asks for a sandbox on the next run, beside Re-run
 * pipeline.
 */
export const Advanced: Story = {
  decorators: [focused(loginTask.id, running, { mode: 'advanced' })],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByTestId('focus-dry-run')).toBeVisible()
    await expect(canvas.getByTestId('focus-run-pipeline')).toBeVisible()
  },
}

/**
 * The login task's run failed because its container did not start: the failure block under the
 * run's summary, with Retry run and the backend's text behind Details.
 */
export const Failed: Story = {
  decorators: [
    focused(
      loginTask.id,
      taskFormSnapshot({
        blocks: boardWith({ ...loginTask, executionId: 'exec_login' }),
        executions: [
          execution({
            status: 'failed',
            failure: failure({
              kind: 'dispatch',
              message: 'The container failed to start.',
              detail: 'Runner pool answered HTTP 503: no capacity in pool acme-runners.',
              stepIndex: 1,
            }),
          }),
        ],
      }),
    ),
  ],
}
