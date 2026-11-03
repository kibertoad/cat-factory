import type { Meta, StoryObj } from '@storybook/vue3'
import type { MergeDecision } from '@cat-factory/contracts'
import { step } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import MergerResultView from './MergerResultView.vue'

// The merger's verdict on the login pull request. The merger scores the change for complexity,
// risk and impact; the engine compares the scores with the merge preset's ceilings and either
// merges the pull request or leaves it for a person. The window shows that outcome and why, each
// score against its ceiling (red when it is the reason for review), and the merger's rationale.
// A run from before the structured verdict shows the merger's prose instead. From the lg width a
// sidebar also gives the step's run facts; the captures are narrower.
//
// The ceilings are the built-in Balanced preset's (`DEFAULT_RISK_POLICY` in kernel); the scores
// and the rationale are made up.
const balanced: MergeDecision['thresholds'] = {
  presetName: 'Balanced',
  maxComplexity: 0.5,
  maxRisk: 0.4,
  maxImpact: 0.5,
  autoMergeEnabled: true,
}

const rationale =
  'A contained change to the refresh path: one new lock, two call sites and tests for both ' +
  'branches. **Recommend merge.**'

function verdict(overrides: Partial<MergeDecision> = {}): MergeDecision {
  return {
    outcome: 'auto_merged',
    reason: 'within_thresholds',
    assessment: { complexity: 0.3, risk: 0.2, impact: 0.35, rationale },
    thresholds: balanced,
    exceededAxes: [],
    changeClass: 'source',
    ...overrides,
  }
}

function opened(merger: { custom?: unknown; output?: string }) {
  return withSeed(() => {
    const run = execution({
      steps: [
        step({ agentKind: 'coder', state: 'done', progress: 1 }),
        step({ agentKind: 'merger', state: 'done', progress: 1, ...merger }),
      ],
      currentStep: 1,
      status: 'done',
    })
    seedSnapshot(snapshot({ executions: [run] }))
    seedResultView({ view: 'merger', blockId: run.blockId, instanceId: run.id, stepIndex: 1 })
  })
}

const meta = {
  title: 'Pipeline/Pages/MergerResultView',
  component: MergerResultView,
  decorators: [opened({ custom: verdict() })],
} satisfies Meta<typeof MergerResultView>
export default meta

type Story = StoryObj<typeof meta>

/** Merged: every score at or under its ceiling, and the rationale. */
export const Default: Story = {}

/** Left for review: the risk score is over its ceiling, so its bar is red. */
export const AwaitingReview: Story = {
  decorators: [
    opened({
      custom: verdict({
        outcome: 'awaiting_review',
        reason: 'exceeded_thresholds',
        assessment: {
          complexity: 0.45,
          risk: 0.62,
          impact: 0.4,
          rationale:
            'The lock changes how every refresh is ordered, and the load test does not cover ' +
            'two regions refreshing at once. **Recommend a human review.**',
        },
        exceededAxes: ['risk'],
      }),
    }),
  ],
}

/** The merger returned nothing the engine could read: no scores, and a line that says so. */
export const NoAssessment: Story = {
  decorators: [
    opened({
      custom: verdict({
        outcome: 'awaiting_review',
        reason: 'no_assessment',
        assessment: undefined,
      }),
    }),
  ],
}

/** A run from before the structured verdict: the merger's prose. */
export const ProseFallback: Story = {
  decorators: [opened({ output: `Complexity 0.3, risk 0.2, impact 0.35.\n\n${rationale}` })],
}

/** The merger step has no verdict and no prose. */
export const Empty: Story = { decorators: [opened({})] }
