import type { Meta, StoryObj } from '@storybook/vue3'
import { approval } from '~/stories/pipelineStep.stories.mocks'
import InitiativePlanNotice from './InitiativePlanNotice.vue'

// The notice an initiative's window shows when its plan waits for approval and the plan has no
// document of its own: it says so, points at the tracker sections below when they have loaded,
// and holds the approve and send back decision.
const meta = {
  title: 'Review/Components/InitiativePlanNotice',
  component: InitiativePlanNotice,
  parameters: { width: 'prose' },
  args: {
    approval: approval({ id: 'appr_auth_plan' }),
    instanceId: 'exec_auth_plan',
    canExecute: true,
    hasSections: true,
  },
} satisfies Meta<typeof InitiativePlanNotice>
export default meta

type Story = StoryObj<typeof meta>

/** The tracker sections are loaded, so the notice points at them as the plan. */
export const Default: Story = {}

/** The sections have not loaded, so the notice does not point below. */
export const NoSections: Story = { args: { hasSections: false } }

/** No right to run: the decision is disabled. */
export const ReadOnly: Story = { args: { canExecute: false } }
