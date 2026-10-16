import type { Meta, StoryObj } from '@storybook/vue3'
import type { TaskSourceState } from '@cat-factory/contracts'
import { listTasksContract } from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { boardBlocks, gatewayService } from '~/stories/board.stories.mocks'
import { sourceTask, taskSources } from '~/stories/integrations.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { useTasksStore } from '~/stores/tasks'
import { useUiStore } from '~/stores/ui'
import TaskImportModal from './TaskImportModal.vue'

// Create a board task from a tracker issue: pick an issue in the inline picker, and the add-task
// form opens prefilled with it. Opened from a service frame, the frame settles where the task
// lands; opened from the command bar, the user picks a frame or module. A parent issue can also
// be spawned as an epic with its children. The trackers are seeded on the tasks store, and the
// imported issues are answered for the modal's load and the picker's.
const meta = {
  title: 'Board/Components/TaskImportModal',
  component: TaskImportModal,
  parameters: {
    api: [
      apiResponse(listTasksContract, {
        pathPrefix: storyWorkspacePrefix,
        body: [
          sourceTask({
            source: 'github',
            externalId: 'acme/api-gateway#12',
            title: 'Return 429 with Retry-After from the login route',
            url: 'https://github.com/acme/api-gateway/issues/12',
            status: 'open',
            type: 'Issue',
            priority: null,
            labels: ['rate-limit'],
            comments: [],
          }),
        ],
      }),
    ],
  },
} satisfies Meta<typeof TaskImportModal>
export default meta

type Story = StoryObj<typeof meta>

/** The shared board and trackers, then open the modal from `containerId` (none: standalone). */
function withImport(
  containerId: string | null,
  options: { sources?: TaskSourceState[]; board?: typeof boardBlocks } = {},
) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(options.board ?? boardBlocks)
    const tasks = useTasksStore()
    tasks.available = true
    tasks.sources = options.sources ?? taskSources
    useUiStore().openTaskImport(null, containerId)
  })
}

/**
 * Opened from API Gateway, which has no modules, so the target is stated. The picker lists the
 * issue already imported from its repository, and the epic row sits below.
 */
export const Default: Story = {
  decorators: [withImport(gatewayService.id)],
}

/** Opened from the command bar: browse title, and a picker for the frame or module. */
export const Standalone: Story = {
  decorators: [withImport(null)],
}

/** No tracker offered: one button per tracker to connect it. */
export const NoTrackerConnected: Story = {
  decorators: [
    withImport(gatewayService.id, {
      sources: taskSources.map((s) => ({ ...s, available: false })),
    }),
  ],
}

/** A board with no service frame: there is nowhere to create a task yet. */
export const NoContainers: Story = {
  decorators: [withImport(null, { board: [] })],
}
