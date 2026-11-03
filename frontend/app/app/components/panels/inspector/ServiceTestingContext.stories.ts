import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import { seedBoard, seedUiMode, withSeed } from '~/stories/withStores'
import ServiceTestingContext from './ServiceTestingContext.vue'
import { openSection, opensTo } from '~/stories/inspectorSection'

// Free prose about how a service is tested, which every tester prompt for the service receives
// as written. A banner says it must not hold a secret. "Discard changes" appears and Save enables
// once the text changes. In the basic tier the section shows only when the service already has text; an
// empty one in the basic tier renders nothing, so there is no story for it. The section starts
// closed, so each story opens it.
const briefed = {
  ...authService,
  testingContext:
    'Sign in as the seeded admin (TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD). Sessions expire after 15 minutes in staging, so refresh before a long flow.',
}

const meta = {
  title: 'Inspector/Components/ServiceTestingContext',
  component: ServiceTestingContext,
  parameters: { width: 'panel' },
  decorators: [
    withSeed(() => {
      seedBoard(boardBlocks)
      seedUiMode('advanced')
    }),
  ],
} satisfies Meta<typeof ServiceTestingContext>
export default meta

type Story = StoryObj<typeof meta>

/** A briefed service. */
export const Default: Story = {
  args: { block: briefed },
  play: opensTo((c) => c.findByDisplayValue(briefed.testingContext)),
}

/** Not briefed yet, in the advanced tier: the empty box. */
export const Empty: Story = {
  args: { block: authService },
  play: opensTo((c) => c.findByTestId('testing-context-input')),
}

/** Edited and not saved. At panel width the counter and both buttons wrap onto two lines. */
export const Edited: Story = {
  args: { block: briefed },
  play: async (context) => {
    await openSection(context.canvasElement)
    await userEvent.type(
      within(context.canvasElement).getByTestId('testing-context-input'),
      ' Use the EU region.',
    )
    await within(context.canvasElement).findByTestId('testing-context-revert')
  },
}

/** The basic tier still shows a service that has text, so it can be read and cleared. */
export const BasicTier: Story = {
  args: { block: briefed },
  decorators: [
    withSeed(() => {
      seedBoard(boardBlocks)
      seedUiMode('basic')
    }),
  ],
  play: opensTo((c) => c.findByDisplayValue(briefed.testingContext)),
}
