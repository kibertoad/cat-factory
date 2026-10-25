import type { Meta, StoryObj } from '@storybook/vue3'
import type { CustomAgentKind, JudgeStepState, JudgeVerdict } from '@cat-factory/contracts'
import { resolveJudgeContract } from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiFailure } from '~/stories/api'
import { step } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import { storyWorkspacePrefix } from '~/stories/workspace'
import JudgeResultView from './JudgeResultView.vue'

// The window for a judge step: a rubric scores the work, and the score is held against the
// task's threshold. It shows the score, what the engine did with it, the judge's summary and its
// findings, worst first. When the score stopped the run, the window also asks what to do: proceed
// anyway, send the work back to the producing step with the findings, or stop. A judge that
// looped shows each round.
//
// No rubric ships with the product; a deployment registers its own, and the judge step carries
// the registration's kind, which the snapshot projects like any custom agent kind. This one, a
// security review, and its findings are made up.
const securityKind: CustomAgentKind = {
  kind: 'security-review',
  container: false,
  executor: 'inline',
  presentation: {
    label: 'Security review',
    icon: 'i-lucide-shield-check',
    color: '#d97706',
    description: 'Scores the change against the security rubric.',
    category: 'review',
    resultView: 'judge',
  },
}

const firstRound: JudgeVerdict = {
  score: 0.48,
  summary: 'The refresh endpoint trusts the client clock.',
  findings: [{ title: 'Expiry read from the request', severity: 'critical' }],
}

const latest: JudgeVerdict = {
  score: 0.62,
  summary:
    '**Below the bar.** The lock is correct, but two things still need work:\n\n' +
    '- the reuse check logs the raw token\n- the rate limit counts per token, not per user',
  findings: [
    {
      title: 'Rate limit is per token',
      severity: 'medium',
      where: 'src/refresh/limit.ts',
      detail: 'A client can rotate tokens to reset its own limit.',
    },
    {
      title: 'Raw refresh token in the reuse log',
      severity: 'high',
      where: 'src/refresh/reuse.ts:41',
      detail: 'Log the token family id instead.',
    },
  ],
}

function judgeState(overrides: Partial<JudgeStepState> = {}): JudgeStepState {
  return {
    status: 'awaiting_decision',
    rubricId: 'security-review',
    rubricName: 'Security review',
    rubricOverridden: false,
    verdict: latest,
    threshold: 0.7,
    disposition: 'park',
    bounces: 2,
    maxBounces: 2,
    model: 'anthropic:claude-opus-5',
    rounds: [],
    ...overrides,
  }
}

function opened(judge: JudgeStepState | undefined) {
  const parked = judge?.status === 'awaiting_decision'
  return withSeed(() => {
    const run = execution({
      steps: [
        step({ agentKind: 'coder', state: 'done', progress: 1 }),
        step({
          agentKind: 'security-review',
          state: parked ? 'waiting_decision' : 'done',
          progress: 1,
          judge,
        }),
      ],
      currentStep: 1,
      status: parked ? 'blocked' : 'done',
    })
    seedSnapshot(snapshot({ executions: [run], customAgentKinds: [securityKind] }))
    seedResultView({ view: 'judge', blockId: run.blockId, instanceId: run.id, stepIndex: 1 })
  })
}

const meta = {
  title: 'Pipeline/Pages/JudgeResultView',
  component: JudgeResultView,
  decorators: [
    opened(
      judgeState({
        status: 'passed',
        disposition: 'pass',
        bounces: 0,
        verdict: {
          score: 0.84,
          summary: '**Passes.** Tokens rotate on use, and reuse revokes the family.',
          findings: [],
        },
      }),
    ),
  ],
} satisfies Meta<typeof JudgeResultView>
export default meta

type Story = StoryObj<typeof meta>

/** Passed: 84% against a 70% threshold, with the summary. */
export const Default: Story = {}

/** The step has no judge state yet. */
export const Empty: Story = { decorators: [opened(undefined)] }

/**
 * 62% after both rework rounds: the run waits. The findings, worst first, and the three choices
 * with a field for more guidance.
 */
export const AwaitingDecision: Story = { decorators: [opened(judgeState())] }

/** Proceed anyway was refused: the error toast, and the typed guidance stays for the next try. */
export const ResolveError: Story = {
  decorators: [opened(judgeState())],
  parameters: {
    api: [
      apiFailure(resolveJudgeContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { executionId: 'exec_login' },
      }),
    ],
  },
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Proceed anyway' }))
    await screen.findByText('Could not record your choice')
  },
}

/** The rubric asked for a model this deployment cannot run, so another model scored it. */
export const ModelUnavailable: Story = {
  decorators: [
    opened(judgeState({ modelPin: { requested: 'gpt-5.6-sol', status: 'unavailable' } })),
  ],
}

/** Three rounds: newest first, each with its score and what the engine did. */
export const SeveralRounds: Story = {
  decorators: [
    opened(
      judgeState({
        rounds: [
          {
            round: 1,
            at: Date.UTC(2026, 9, 11, 10, 0),
            verdict: firstRound,
            disposition: 'bounce',
            model: 'anthropic:claude-opus-5',
          },
          {
            round: 2,
            at: Date.UTC(2026, 9, 11, 10, 40),
            verdict: { ...latest, score: 0.55 },
            disposition: 'bounce',
            model: 'anthropic:claude-opus-5',
          },
          {
            round: 3,
            at: Date.UTC(2026, 9, 11, 11, 20),
            verdict: latest,
            disposition: 'park',
            model: 'anthropic:claude-opus-5',
          },
        ],
      }),
    ),
  ],
}
