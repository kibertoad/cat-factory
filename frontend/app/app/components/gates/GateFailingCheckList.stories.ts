import type { Meta, StoryObj } from '@storybook/vue3'
import GateFailingCheckList from './GateFailingCheckList.vue'

// The failing CI checks of a gate: each row links to the check's run when a URL is known, and
// shows its conclusion, or "failure" when none was reported. The CI precheck panel uses the card
// layout; the gate's per-attempt timeline uses `dense`.
const meta = {
  title: 'Review/Components/GateFailingCheckList',
  component: GateFailingCheckList,
  parameters: { width: 'panel' },
} satisfies Meta<typeof GateFailingCheckList>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    checks: [
      { name: 'Build & typecheck', conclusion: 'failure', url: 'https://example.invalid/runs/1' },
      { name: 'test-db', conclusion: 'failure', url: 'https://example.invalid/runs/2' },
    ],
  },
}

/** Dense, as in the per-attempt timeline: smaller, with no border per row. */
export const Dense: Story = {
  args: {
    dense: true,
    checks: [
      { name: 'Build & typecheck', conclusion: 'failure', url: 'https://example.invalid/runs/1' },
      { name: 'test-db', conclusion: 'timed_out', url: 'https://example.invalid/runs/2' },
    ],
  },
}

/** No URL and no conclusion: plain text, and the "failure" fallback. */
export const WithoutLinks: Story = {
  args: { checks: [{ name: 'required-reviewers', conclusion: null, url: null }] },
}

/** Eight failing checks. */
export const Many: Story = {
  args: {
    checks: Array.from({ length: 8 }, (_, i) => ({
      name: `shard-${i + 1} (vitest, postgres)`,
      conclusion: 'failure',
      url: `https://example.invalid/runs/${i + 10}`,
    })),
  },
}
