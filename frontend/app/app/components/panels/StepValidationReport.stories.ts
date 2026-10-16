import type { Meta, StoryObj } from '@storybook/vue3'
import {
  validationCheck as check,
  validationFailed,
  validationPassed,
} from '~/stories/stepReports.stories.mocks'
import StepValidationReport from './StepValidationReport.vue'

// The pre-PR validation report: the service's check commands, run by the harness before the PR
// opened. A summary line, then every check in the order it ran, with an exit code or "timed out"
// on a failed check and the tail of its output when there is one.
const meta = {
  title: 'Pipeline/Components/StepValidationReport',
  component: StepValidationReport,
  parameters: { width: 'panel' },
} satisfies Meta<typeof StepValidationReport>
export default meta

type Story = StoryObj<typeof meta>

/** Everything passed, first try. */
export const Default: Story = { args: { report: validationPassed } }

/** A check still failing after the last attempt, with its output tail. No PR was opened. */
export const Failed: Story = { args: { report: validationFailed } }

/** A check that timed out: the badge says so instead of giving an exit code. */
export const TimedOut: Story = {
  args: {
    report: {
      passed: false,
      attempts: 3,
      maxAttempts: 3,
      outcomes: [check('e2e', 'pnpm e2e', false, { timedOut: true, durationMs: 900000 })],
    },
  },
}

/**
 * Passed on the last allowed attempt. The summary names the attempt but not the limit, and with
 * one check it reads "All 1 checks".
 */
export const PassedOnLastAttempt: Story = {
  args: {
    report: {
      passed: true,
      attempts: 3,
      maxAttempts: 3,
      outcomes: [check('test', 'pnpm test:run', true)],
    },
  },
}

/**
 * No checks ran. It renders "All 0 checks passed on attempt 1", the same as a green suite. A
 * finding, not filed.
 */
export const NoChecks: Story = {
  args: { report: { passed: true, attempts: 1, maxAttempts: 3, outcomes: [] } },
}
