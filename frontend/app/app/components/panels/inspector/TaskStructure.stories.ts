import { resolvedFragmentsContract } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import { boardBlocks, loginTask, logoutTask } from '~/stories/board.stories.mocks'
import { fragmentCatalog } from '~/stories/fragments.stories.mocks'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import TaskStructure from './TaskStructure.vue'

// A task's module and its own best-practice fragments. The module picker offers the modules of the
// task's service, plus the task's declared module when no block exists for it yet. The fragment
// picker offers only fragments that apply to the task's block type. The section starts closed, so
// each story opens it.
const meta = {
  title: 'Inspector/Components/TaskStructure',
  component: TaskStructure,
  decorators: [
    withSeed(() => {
      seedBoard(boardBlocks)
      seedWorkspace()
    }),
  ],
  // The picker loads the catalog itself on mount.
  parameters: {
    width: 'panel',
    api: [
      apiResponse(resolvedFragmentsContract, {
        pathPrefix: storyWorkspacePrefix,
        body: fragmentCatalog,
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('inspector-section-toggle'))
  },
} satisfies Meta<typeof TaskStructure>
export default meta

type Story = StoryObj<typeof meta>

/** In the Sessions module, with one fragment of its own. */
export const Default: Story = {
  args: { block: { ...loginTask, moduleName: 'Sessions', fragmentIds: ['node.performance'] } },
}

/** Directly under its service, with no fragments. */
export const NoModule: Story = { args: { block: logoutTask } }

/** A declared module with no block yet: the picker still offers and shows it. */
export const UndeclaredModule: Story = { args: { block: { ...logoutTask, moduleName: 'Audit' } } }
