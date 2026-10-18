import type { Meta, StoryObj } from '@storybook/vue3'
import FailureOutput from './FailureOutput.vue'

// A failure's full output with a copy button: the one rendering that the failure block's Details
// and the run telemetry's "Show detail" share. The caller passes the tone of its surface, and
// decides through `failureOutput` whether there is anything to show.
const meta = {
  title: 'Board/Components/FailureOutput',
  component: FailureOutput,
  parameters: { width: 'panel' },
  args: {
    text: 'exit code 137\nkilled: out of memory after 4m12s\nimage: runner:2026.10.1',
    preClass: 'bg-app-error-950/60 text-3xs text-app-error-200/80',
  },
} satisfies Meta<typeof FailureOutput>
export default meta

type Story = StoryObj<typeof meta>

/** In the failure block's tone. */
export const Default: Story = {}

/** In a list of earlier failures: the neutral tone. */
export const Neutral: Story = {
  args: { preClass: 'bg-app-950/80 text-3xs text-muted' },
}

/** A long output scrolls inside its box instead of growing the block. */
export const Long: Story = {
  args: {
    text: Array.from({ length: 40 }, (_, i) => `line ${i + 1}: retrying connection`).join('\n'),
  },
}
