import type { Meta, StoryObj } from '@storybook/vue3'
import { testerState, testReport } from '~/stories/testing.stories.mocks'
import StepTestReport from './StepTestReport.vue'

// A tester step's latest report: the verdict, what was tested, each area's outcome, the verdict
// on each requirement in the service's spec, and the concerns by severity. The phase line says how
// far the tester and fixer loop has got. A requirement has three verdicts on purpose: not checked
// and broken must not look the same.
const meta = {
  title: 'Pipeline/Components/StepTestReport',
  component: StepTestReport,
  parameters: { width: 'panel' },
  args: { report: testReport(), phase: null },
} satisfies Meta<typeof StepTestReport>
export default meta

type Story = StoryObj<typeof meta>

/** Not greenlit: one area failed, one requirement not met and one not covered. */
export const Default: Story = {}

/** The fixer is working on the failures, on its first of three attempts. */
export const Fixing: Story = { args: { phase: testerState() } }
