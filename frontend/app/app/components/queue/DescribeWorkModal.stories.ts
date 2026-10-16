import type { Meta, StoryObj } from '@storybook/vue3'
import { screen, userEvent } from 'storybook/test'
import { authService } from '~/stories/board.stories.mocks'
import { taskFormSnapshot } from '~/stories/taskForm.stories.mocks'
import { seedSnapshot, seedUiMode, seedViewer, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import type { UiMode } from '~/utils/uiMode'
import DescribeWorkModal from './DescribeWorkModal.vue'

// The one-box intake: what needs doing, which service, feature or bug. The first line becomes
// the title and the whole text the description. How it runs sits behind one disclosure that
// names the defaults; the other kinds and attachments hand the text to the full add-task form.
// Add and Add and start send requests no story answers. The board is the shared task form board
// (`taskForm.stories.mocks.ts`), with two services.
function opened(
  { serviceId = authService.id, mode = 'basic', viewer = false } = {} as {
    serviceId?: string | null
    mode?: UiMode
    viewer?: boolean
  },
) {
  return withSeed(() => {
    seedSnapshot(taskFormSnapshot())
    seedUiMode(mode)
    if (viewer) seedViewer()
    useUiStore().openDescribeWork(serviceId)
  })
}

const text =
  'Lock the account after five failed sign-ins. After five wrong passwords in ten minutes, ' +
  'lock the account for fifteen minutes and email the owner.'

async function describe() {
  await userEvent.type(await screen.findByTestId('describe-work-text'), text)
}

const meta = {
  title: 'Board/Components/DescribeWorkModal',
  component: DescribeWorkModal,
} satisfies Meta<typeof DescribeWorkModal>
export default meta

type Story = StoryObj<typeof meta>

/** Opened from Auth Service: the box, the service picked, Feature, and the run summary. */
export const Default: Story = {
  decorators: [opened()],
}

/** Text typed: the title it is saved as, and both Add buttons on. */
export const Filled: Story = {
  decorators: [opened()],
  play: describe,
}

/** The advanced tier, with the disclosure open: the pipeline, the merge policy and the preset. */
export const OverridesOpen: Story = {
  decorators: [opened({ mode: 'advanced' })],
  play: async () => {
    await userEvent.click(await screen.findByTestId('describe-work-overrides'))
  },
}

/**
 * Opened from the queue with two services and no filter: no service is guessed, so the Add
 * buttons, More kinds and Attach context wait for one.
 */
export const NoServiceChosen: Story = {
  decorators: [opened({ serviceId: null })],
  play: describe,
}

/** A board viewer can type, but cannot add. */
export const ReadOnly: Story = {
  decorators: [opened({ viewer: true })],
  play: describe,
}
