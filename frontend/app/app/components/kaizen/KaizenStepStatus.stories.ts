import type { Meta, StoryObj } from '@storybook/vue3'
import type { KaizenGrading } from '@cat-factory/contracts'
import { getKaizenRunGradingsContract } from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { gradingHistory, kaizenGrading } from '~/stories/kaizen.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import KaizenStepStatus from './KaizenStepStatus.vue'

// The Kaizen grading of one finished step, inside the run window's step detail: queued, being
// graded, failed, or the grade with the grader's summary and recommendations. The section loads
// the run's gradings itself, and shows nothing while the step has none. Each story answers that
// read with the coder step's grading in one state.
const meta = {
  title: 'Run telemetry/Components/KaizenStepStatus',
  component: KaizenStepStatus,
  args: { instanceId: 'exec_login', stepIndex: 1 },
  decorators: [withSeed(seedWorkspace)],
  parameters: { width: 'prose', api: [gradingIs(kaizenGrading())] },
} satisfies Meta<typeof KaizenStepStatus>
export default meta

type Story = StoryObj<typeof meta>

function gradingIs(grading: KaizenGrading) {
  return apiResponse(getKaizenRunGradingsContract, {
    pathPrefix: storyWorkspacePrefix,
    pathParams: { executionId: grading.executionId },
    body: { gradings: [grading] },
  })
}

/** A 3, in the warning colour, with the summary, two recommendations and the grader's model. */
export const Default: Story = {}

/** A 5 with nothing to improve: the line says so in place of the recommendations. */
export const NoImprovements: Story = {
  parameters: {
    api: [
      gradingIs(
        kaizenGrading({
          grade: 5,
          summary: 'Read the plan, made the change in two edits and ran the tests once.',
          recommendations: [],
        }),
      ),
    ],
  },
}

/** Queued: the clock, and a line that says it runs after the run. */
export const Scheduled: Story = {
  parameters: {
    api: [
      gradingIs(
        kaizenGrading({
          status: 'scheduled',
          grade: null,
          summary: '',
          recommendations: [],
          graderModel: null,
        }),
      ),
    ],
  },
}

/** Being graded: the spinner, and nothing below the title yet. */
export const Running: Story = {
  parameters: {
    api: [
      gradingIs(
        kaizenGrading({ status: 'running', grade: null, summary: '', recommendations: [] }),
      ),
    ],
  },
}

/** The grader's reply could not be read: the backend's message in the error colour. */
export const Failed: Story = {
  parameters: {
    api: [
      gradingIs(
        kaizenGrading({
          status: 'failed',
          grade: null,
          summary: '',
          recommendations: [],
          error: gradingHistory[1]!.error,
        }),
      ),
    ],
  },
}
