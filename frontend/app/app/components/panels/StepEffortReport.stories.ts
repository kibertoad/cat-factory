import type { Meta, StoryObj } from '@storybook/vue3'
import { effortReport } from '~/stories/stepReports.stories.mocks'
import StepEffortReport from './StepEffortReport.vue'

// A container agent's own rating of how hard the work was (1 to 10), with optional prose. Every
// field except `difficulty` can be missing. The bar colour follows the band in `utils/effort.ts`:
// 1 to 4 easy, 5 to 7 moderate, 8 to 10 hard. The stories sit on the band edges.
const meta = {
  title: 'Pipeline/Components/StepEffortReport',
  component: StepEffortReport,
  parameters: { width: 'panel' },
} satisfies Meta<typeof StepEffortReport>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = { args: { report: effortReport } }

/** The last easy value. */
export const Easy: Story = { args: { report: { difficulty: 4, summary: 'A one-line change.' } } }

/** The first moderate value, with no prose. An unreadable difficulty also falls back to 5. */
export const ModerateBoundary: Story = { args: { report: { difficulty: 5 } } }

/** The first hard value, with every field filled. */
export const Hard: Story = {
  args: {
    report: {
      difficulty: 8,
      summary: 'The auth flow spans three packages and the contract is implicit.',
      reducedEffectiveness: 'No way to run the e2e suite locally, so every check cost a CI round.',
      obstacles: [
        'Session shape differs between the worker and node runtimes',
        'The failing test had no assertion message',
        'Two helpers named `refresh` in the same file',
      ],
    },
  },
}

/** Flat, as a result window's footer embeds it: no heading and no border. */
export const Flat: Story = {
  args: { variant: 'flat', report: { difficulty: 4, summary: 'Mostly mechanical.' } },
}
