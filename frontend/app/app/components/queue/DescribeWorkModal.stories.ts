import type { Meta, StoryObj } from '@storybook/vue3'
import { expect, screen, userEvent, waitFor } from 'storybook/test'
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

/** Type the text, wait for the title it is saved as, and return the Add button. */
async function describe() {
  await userEvent.type(await screen.findByTestId('describe-work-text'), text)
  await screen.findByTestId('describe-work-title')
  return screen.getByTestId('describe-work-add')
}

/** Type the text, then wait until Add is enabled (`true`) or stays disabled (`false`). */
function describeThenAdd(enabled: boolean) {
  return async () => {
    const add = await describe()
    await waitFor(() => (enabled ? expect(add).toBeEnabled() : expect(add).toBeDisabled()))
  }
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
  play: describeThenAdd(true),
}

/** The advanced tier, with the disclosure open: the pipeline, the merge policy and the preset. */
export const OverridesOpen: Story = {
  decorators: [opened({ mode: 'advanced' })],
  play: async () => {
    await userEvent.click(await screen.findByTestId('describe-work-overrides'))
    await screen.findByText('Pipeline', { selector: 'label' })
  },
}

/**
 * Opened from the queue with two services and no filter: no service is guessed, so the Add
 * buttons, More kinds and Attach context wait for one.
 */
export const NoServiceChosen: Story = {
  decorators: [opened({ serviceId: null })],
  play: describeThenAdd(false),
}

/**
 * A board viewer can type, but cannot add, and More kinds and Attach context are off: both open
 * the full add-task form, whose create would be refused.
 */
export const ReadOnly: Story = {
  decorators: [opened({ viewer: true })],
  play: async () => {
    await describeThenAdd(false)()
    await expect(screen.getByTestId('describe-work-more-kinds')).toBeDisabled()
    await expect(screen.getByTestId('describe-work-attach-context')).toBeDisabled()
  },
}
