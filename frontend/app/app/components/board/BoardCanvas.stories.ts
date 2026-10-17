import type { Meta, StoryObj } from '@storybook/vue3'
import {
  authService,
  boardBlocks,
  gatewayService,
  loginTask,
  sessionEpic,
} from '~/stories/board.stories.mocks'
import { boardApi } from '~/stories/boardApi'
import { inspectorApi } from '~/stories/inspectorApi'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { authServiceRow } from '~/stories/vcs.stories.mocks'
import { withSeed, withSnapshot } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import InspectorPanel from '~/components/panels/InspectorPanel.vue'
import BoardCanvas from './BoardCanvas.vue'

// The board canvas without the app shell: the service frames at their recorded positions and
// sizes, with pan and zoom. It reads only stores, so the story fills them from one workspace
// snapshot; the frames' positions come from the snapshot's blocks, as the backend projects them.
// Dragging a card or a frame sends a write, which `boardApi` answers from memory.
const placed = new Map([
  [authService.id, { ...authService, position: { x: 0, y: 0 }, size: { w: 760, h: 460 } }],
  [gatewayService.id, { ...gatewayService, position: { x: 820, y: 0 }, size: { w: 520, h: 360 } }],
  [loginTask.id, { ...loginTask, executionId: 'exec_login' }],
  [sessionEpic.id, { ...sessionEpic, position: { x: 0, y: -160 } }],
])

const blocks = boardBlocks.map((b) => placed.get(b.id) ?? b)

const meta = {
  title: 'Board/Pages/BoardCanvas',
  component: BoardCanvas,
  parameters: { layout: 'fullscreen', api: boardApi(blocks) },
  render: () => ({
    components: { BoardCanvas },
    template: '<div class="h-screen"><BoardCanvas /></div>',
  }),
  decorators: [
    withSnapshot(
      snapshot({
        blocks,
        executions: [execution()],
        serviceCatalog: [authServiceRow],
      }),
    ),
  ],
} satisfies Meta<typeof BoardCanvas>
export default meta

type Story = StoryObj<typeof meta>

/** Two services, their tasks in lanes, and an epic linked to its members across both. */
export const Default: Story = {}

/**
 * The canvas with the inspector beside it, as the board page lays them out (`pages/index.vue`),
 * without the toolbar and the sidebar. A task starts selected; clicking another card, a frame or
 * the epic opens it in the inspector, and the close button clears the selection. Focus does
 * nothing here, because the focus view is mounted by the page.
 */
export const WithInspector: Story = {
  parameters: { api: [...boardApi(blocks), ...inspectorApi()] },
  render: () => ({
    components: { BoardCanvas, InspectorPanel },
    template: '<main class="relative h-screen min-w-0"><BoardCanvas /><InspectorPanel /></main>',
  }),
  decorators: [withSeed(() => useUiStore().select(loginTask.id))],
}
