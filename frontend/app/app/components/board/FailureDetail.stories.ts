import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import FailureDetail from './FailureDetail.vue'

// The "Show detail" disclosure under a failure message, with a copy button on the detail. It
// renders nothing when `detail` is null or repeats the message, so there is no story for that.
// The caller passes the two classes, to match the surface it sits on.
const meta = {
  title: 'Board/Components/FailureDetail',
  component: FailureDetail,
  parameters: { width: 'panel' },
  args: {
    message: 'The container was lost mid-run.',
    summaryClass: 'text-xs text-muted',
    preClass: 'mt-1 text-2xs text-muted whitespace-pre-wrap',
  },
} satisfies Meta<typeof FailureDetail>
export default meta

type Story = StoryObj<typeof meta>

const detail = 'exit code 137\nkilled: out of memory after 4m12s\nimage: runner:2026.10.1'

export const Default: Story = { args: { detail } }

/** Opened. Here the chevron still points right: the same icon-swap fault as `SecretInput`. */
export const Open: Story = {
  args: { detail },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Show detail' }))
  },
}
