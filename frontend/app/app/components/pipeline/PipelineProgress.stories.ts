import type { Meta, StoryObj } from '@storybook/vue3'
import { stepMetrics } from '~/stories/observability.stories.mocks'
import {
  approval,
  decision,
  failure,
  prReview,
  step,
  subtasks,
} from '~/stories/pipelineStep.stories.mocks'
import { modelOption } from '~/stories/providers.stories.mocks'
import { execution } from '~/stories/snapshot.stories.mocks'
import { seedModelCatalog, seedWorkspace, withSeed } from '~/stories/withStores'
import PipelineProgress from './PipelineProgress.vue'

// A run as a vertical timeline: a summary with the run's status, how many agents are done and the
// overall percentage, then one card per step with its state, clock, todo list and model, and the
// action a parked step waits for (approve a plan, answer a question, pick review findings). A
// click on a step opens its reader, and a step's hover button restarts the run from it; neither
// is answered here. The model catalog is seeded so the model has its name.
//
// A working step's clock is relative to now, so it starts four minutes before the story loads.
const KIMI = 'workers-ai:@cf/moonshotai/kimi-k2.7-code'
const architectDone = step({
  agentKind: 'architect',
  state: 'done',
  progress: 1,
  model: KIMI,
  startedAt: Date.UTC(2026, 9, 11, 9, 2),
  finishedAt: Date.UTC(2026, 9, 11, 9, 9, 30),
})
const coderWorking = step({
  agentKind: 'coder',
  state: 'working',
  progress: 0.5,
  model: KIMI,
  startedAt: Date.now() - 4 * 60_000,
  metrics: stepMetrics(),
  subtasks: {
    ...subtasks(2, 4, 1),
    items: [
      { label: 'Add a single-flight lock around refresh', status: 'completed' },
      { label: 'Revoke the family on reuse', status: 'completed' },
      { label: 'Cover two refreshes at once', status: 'in_progress' },
      { label: 'Update the session docs', status: 'pending' },
    ],
  },
})
const pending = (agentKind: string) => step({ agentKind, state: 'pending', progress: 0 })

const meta = {
  title: 'Pipeline/Components/PipelineProgress',
  component: PipelineProgress,
  args: {
    instance: execution({ steps: [architectDone, coderWorking, pending('pr-reviewer')] }),
  },
  parameters: { width: 'prose' },
  decorators: [
    withSeed(() => {
      seedWorkspace()
      seedModelCatalog([modelOption()])
    }),
  ],
} satisfies Meta<typeof PipelineProgress>
export default meta

type Story = StoryObj<typeof meta>

/** The coder at work: its todo list, the model and its activity bar. */
export const Default: Story = {}

/** The architect's plan waits for a person: Review & approve. */
export const AwaitingApproval: Story = {
  args: {
    instance: execution({
      steps: [
        step({ ...architectDone, state: 'waiting_decision', approval: approval() }),
        pending('coder'),
        pending('pr-reviewer'),
      ],
      currentStep: 0,
      status: 'blocked',
    }),
  },
}

/** The architect asked a question: a button with the question opens it. */
export const AwaitingDecision: Story = {
  args: {
    instance: execution({
      steps: [
        step({ ...architectDone, state: 'waiting_decision', decision: decision() }),
        pending('coder'),
        pending('pr-reviewer'),
      ],
      currentStep: 0,
      status: 'blocked',
    }),
  },
}

/** The question was answered: the answer, under the architect. */
export const DecisionChosen: Story = {
  args: {
    instance: execution({
      steps: [
        step({ ...architectDone, decision: decision({ chosen: 'A Postgres advisory lock' }) }),
        coderWorking,
        pending('pr-reviewer'),
      ],
    }),
  },
}

/** The run failed while the coder was working: the coder reads Failed, and no clock runs. */
export const Failed: Story = {
  args: {
    instance: execution({
      steps: [architectDone, coderWorking, pending('pr-reviewer')],
      status: 'failed',
      failure: failure({ occurredAt: Date.now() - 60_000, stepIndex: 1 }),
    }),
  },
}

/** The coder's container is still starting. */
export const ContainerStarting: Story = {
  args: {
    instance: execution({
      steps: [
        architectDone,
        step({
          agentKind: 'coder',
          state: 'working',
          progress: 0,
          startedAt: Date.now() - 20_000,
          container: { status: 'starting' },
        }),
        pending('pr-reviewer'),
      ],
    }),
  },
}

/** The pull request review waits for a person to pick the findings: Review findings. */
export const PrReviewAwaiting: Story = {
  args: {
    instance: execution({
      steps: [
        architectDone,
        step({ ...architectDone, agentKind: 'coder' }),
        step({
          agentKind: 'pr-reviewer',
          state: 'waiting_decision',
          progress: 1,
          prReview: prReview('awaiting_selection'),
          approval: approval({ id: 'appr_login_findings' }),
        }),
      ],
      currentStep: 2,
      status: 'blocked',
    }),
  },
}

/** Every step done. */
export const Done: Story = {
  args: {
    instance: execution({
      steps: [
        architectDone,
        step({ ...architectDone, agentKind: 'coder' }),
        step({ ...architectDone, agentKind: 'pr-reviewer' }),
      ],
      currentStep: 2,
      status: 'done',
    }),
  },
}
