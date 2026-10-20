import type { Meta, StoryObj } from '@storybook/vue3'
import { block } from '~/stories/block.stories.mocks'
import { boardBlocks, boardWith, sessionEpic } from '~/stories/board.stories.mocks'
import { seedBoard, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import EpicNode from './EpicNode.vue'

// An epic on the canvas: a card that rolls up the tasks that join it through their `epicId`. It
// reads the epic and its members from the board store, so each story seeds the shared board,
// where all four tasks belong to the Session hardening epic.
const meta = {
  title: 'Board/Components/EpicNode',
  component: EpicNode,
  args: { id: sessionEpic.id },
  decorators: [withSeed(() => seedBoard(boardBlocks))],
} satisfies Meta<typeof EpicNode>
export default meta

type Story = StoryObj<typeof meta>

/**
 * One of four tasks done, so the bar is a quarter full, and two in flight (one in progress, one
 * with a pull request ready).
 */
export const Default: Story = {}

/** An epic no task has joined yet: 0/0, an empty bar and a line that says so. */
export const NoTasks: Story = {
  args: { id: 'epic_audit' },
  decorators: [
    withSeed(() =>
      seedBoard(
        boardWith(
          block({
            id: 'epic_audit',
            title: 'Audit trail',
            level: 'epic',
            parentId: null,
            status: 'planned',
            progress: 0,
          }),
        ),
      ),
    ),
  ],
}

/** The selected block: a brighter border and a ring. */
export const Selected: Story = {
  decorators: [withSeed(() => useUiStore().select(sessionEpic.id))],
}
