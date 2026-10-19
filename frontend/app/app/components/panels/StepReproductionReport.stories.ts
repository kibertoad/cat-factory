import type { Meta, StoryObj } from '@storybook/vue3'
import { reproductionReport as report } from '~/stories/stepReports.stories.mocks'
import StepReproductionReport from './StepReproductionReport.vue'

// The proof that a bugfix fixed the bug: the reproducing check the harness ran against the tree
// before the fix and after it, with both outputs. The verdict comes from the two exit codes, not
// from the model. The step detail shows it as a card; the result window footer shows it flat,
// under its own disclosure.
const meta = {
  title: 'Pipeline/Components/StepReproductionReport',
  component: StepReproductionReport,
  parameters: { width: 'panel' },
  args: { report: report(), variant: 'card' },
} satisfies Meta<typeof StepReproductionReport>
export default meta

type Story = StoryObj<typeof meta>

/** Reproduced: the check failed before the fix and passes after it. */
export const Default: Story = {}

/**
 * Inconclusive: the check already passed before the fix, so it proves nothing, and the second run
 * was not needed.
 */
export const Inconclusive: Story = {
  args: {
    report: report({
      status: 'inconclusive',
      base: {
        exitCode: 0,
        passed: true,
        durationMs: 7_900,
        outputTail: ' ✓ test/refresh.spec.ts (4)',
      },
      final: undefined,
      attempts: 2,
      note: 'The test passes on the pre-fix tree: it does not exercise the expired-token path.',
    }),
  },
}

/** No reproducing check is possible: the reason, and how the fix is verified instead. */
export const DeclaredInfeasible: Story = {
  args: {
    report: report({
      status: 'declared_infeasible',
      command: '',
      testPaths: [],
      base: undefined,
      final: undefined,
      reason:
        'The race needs two regions writing the same session within a few milliseconds; the test environment has one region.',
      alternativeVerification:
        'A unit test pins the compare-and-swap on the session row, and the fix ships behind a metric on rejected writes.',
    }),
  },
}

/** The flat form the result window footer embeds, without the card's heading and border. */
export const Flat: Story = { args: { variant: 'flat' } }
