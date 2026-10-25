import type { Meta, StoryObj } from '@storybook/vue3'
import { resumeSpendContract } from '@cat-factory/contracts'
import { screen, userEvent, within } from 'storybook/test'
import { apiFailure } from '~/stories/api'
import { spendStatus } from '~/stories/providers.stories.mocks'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { seedViewer, withSeed } from '~/stories/withStores'
import { useWorkspaceStore } from '~/stores/workspace'
import SpendWarningBanner from './SpendWarningBanner.vue'

// The red card over the board once the board's monthly budget is spent: runs are paused, the
// figures say by how much, and Resume anyway lifts the pause. It renders only while the spend
// status says `exceeded`, so every story seeds one. The board's overlay layer positions it; the
// story shows the card alone.
const exceeded = spendStatus({
  inputTokens: 51_240_000,
  outputTokens: 7_830_000,
  costSpent: 503.8,
  costLimit: 500,
  exceeded: true,
})

const meta = {
  title: 'Board/Components/SpendWarningBanner',
  component: SpendWarningBanner,
  decorators: [
    withSeed(() => {
      useWorkspaceStore().spend = exceeded
    }),
  ],
} satisfies Meta<typeof SpendWarningBanner>
export default meta

type Story = StoryObj<typeof meta>

/** Spent, budget and tokens this month, and Resume anyway. */
export const Default: Story = {}

/** A board viewer sees the same card with Resume anyway disabled. */
export const Viewer: Story = {
  decorators: [withSeed(seedViewer)],
}

/** Resume anyway was refused: one error toast, and the card stays. */
export const ResumeFailed: Story = {
  parameters: {
    api: [apiFailure(resumeSpendContract, { pathPrefix: storyWorkspacePrefix })],
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Resume anyway' }))
    await screen.findByText('Could not resume agent execution')
  },
}
