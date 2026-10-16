import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import { initiativePlanDocument as plan } from '~/stories/initiative.stories.mocks'
import { approval, step } from '~/stories/pipelineStep.stories.mocks'
import StepRunMeta from '~/components/panels/StepRunMeta.vue'
import InitiativePlanReview from './InitiativePlanReview.vue'

// The initiative window while its plan waits for approval: the plan as a document, an outline
// beside it with the run details, and a rail with the comments and the decision. A click on a
// block of the plan starts a comment on it. The document is the shared one
// (`initiativePlanDocument` in `initiative.stories.mocks.ts`). The outline and the run details
// show from the lg width, and the rail drops under the document below it.

/** The planner's step, parked on the plan's gate after six minutes, so its clock is stopped. */
const startedAt = Date.UTC(2026, 9, 12, 8, 40)
const plannerStep = step({
  agentKind: 'initiative-planner',
  state: 'working',
  progress: 0.5,
  startedAt,
  pausedAt: startedAt + 6 * 60_000,
  model: 'workers-ai:@cf/zai-org/glm-5.2',
  runId: 'exec_identity_plan',
})

const meta = {
  title: 'Review/Components/InitiativePlanReview',
  component: InitiativePlanReview,
  args: {
    approval: approval({ id: 'appr_identity_plan', proposal: plan }),
    instanceId: 'exec_identity_plan',
    canExecute: true,
    planDocument: plan,
  },
  // The window gives the review its whole body, so the story gives it the screen.
  render: (args) => ({
    components: { InitiativePlanReview, StepRunMeta },
    setup: () => ({ args, plannerStep }),
    template: `
      <div class="flex h-screen">
        <InitiativePlanReview v-bind="args">
          <template #run-details>
            <StepRunMeta :step="plannerStep" instance-id="exec_identity_plan" :step-number="2" :total-steps="4" />
          </template>
        </InitiativePlanReview>
      </div>`,
  }),
} satisfies Meta<typeof InitiativePlanReview>
export default meta

type Story = StoryObj<typeof meta>

/** The block that holds the first item's description. */
function rotationBlock(canvasElement: HTMLElement) {
  return within(within(canvasElement).getByTestId('initiative-plan-document')).getByText(
    /Each refresh issues a new token/,
  )
}

/** Two phases and three items, the policy, a decision and a caveat, with a hint to comment. */
export const Default: Story = {}

/**
 * A document with no headings, so there is no outline: the run details take the sidebar. The
 * engine's renderer always starts with a heading, so this layout shows only if that changes.
 */
export const NoHeadings: Story = {
  args: {
    planDocument:
      'Rotate refresh tokens on use, then record every session event in the audit log. ' +
      'Two items run at once.',
  },
}

/** A block of the plan clicked: the composer quotes it in the rail. */
export const Commenting: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(rotationBlock(canvasElement))
  },
}

/** One comment added on the first item: it is listed, and Send back is enabled. */
export const WithComments: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(rotationBlock(canvasElement))
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByTestId('initiative-plan-comment-body'),
      'Split this: revoke on reuse first, then rotate.',
    )
    await userEvent.click(canvas.getByTestId('initiative-plan-comment-add'))
  },
}

/** No right to run: a click starts no comment, there is no hint, and the decision is disabled. */
export const ReadOnly: Story = { args: { canExecute: false } }
