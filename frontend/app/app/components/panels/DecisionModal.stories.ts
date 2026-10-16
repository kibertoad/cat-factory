import type { Meta, StoryObj } from '@storybook/vue3'
import { resolveDecisionContract } from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiPending } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { decision, step } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import DecisionModal from './DecisionModal.vue'

// A question an agent stopped the run to ask: who asks it and on which task, the question, and
// one button per answer. A click sends the answer and closes the modal when the run takes it;
// while it is in flight the other answers disable. The architect's question on the login plan is
// made up.
function asking(blockId = 'task_login') {
  return withSeed(() => {
    const run = execution({
      blockId,
      steps: [
        step({
          agentKind: 'architect',
          state: 'waiting_decision',
          progress: 1,
          decision: decision(),
        }),
        step({ agentKind: 'coder', state: 'pending', progress: 0 }),
        step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
      ],
      currentStep: 0,
      status: 'blocked',
    })
    seedSnapshot(snapshot({ executions: [run] }))
    useUiStore().openDecision(run.id, decision().id)
  })
}

const meta = {
  title: 'Pipeline/Components/DecisionModal',
  component: DecisionModal,
  decorators: [asking()],
} satisfies Meta<typeof DecisionModal>
export default meta

type Story = StoryObj<typeof meta>

/** The architect asks on Login endpoint: three answers. */
export const Default: Story = {}

/** The run's task is not on this board: only the agent is named. */
export const WithoutBlock: Story = { decorators: [asking('task_elsewhere')] }

/** An answer is in flight: it spins, and the other two disable. */
export const Resolving: Story = {
  parameters: {
    api: [
      apiPending(resolveDecisionContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { executionId: 'exec_login', decisionId: decision().id },
      }),
    ],
  },
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'In process only' }))
  },
}
