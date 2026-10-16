import { resolvedFragmentsContract } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import { fragmentCatalog } from '~/stories/fragments.stories.mocks'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import ServiceFragments from './ServiceFragments.vue'

// The best-practice fragments chosen for a whole service, as removable badges under a picker. A
// new task in the service starts with this selection. The section starts closed in the inspector,
// so each story opens it.
const meta = {
  title: 'Inspector/Components/ServiceFragments',
  component: ServiceFragments,
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
} satisfies Meta<typeof ServiceFragments>
export default meta

type Story = StoryObj<typeof meta>

/** Two fragments chosen. */
export const Default: Story = {
  args: {
    block: { ...authService, serviceFragmentIds: ['node.performance', 'node.best-practices'] },
  },
}

/** None chosen: the empty line. */
export const Empty: Story = { args: { block: authService } }

/** A chosen id the catalog no longer has: it shows by its raw id, still removable. */
export const UnknownFragment: Story = {
  args: {
    block: { ...authService, serviceFragmentIds: ['node.performance', 'acme.retired-rule'] },
  },
}
