import type { Meta, StoryObj } from '@storybook/vue3'
import type { GateStepState } from '@cat-factory/contracts'
import type { ExecutionInstance } from '~/types/domain'
import type { PipelineStep } from '~/types/execution'
import { boardWith, loginTask } from '~/stories/board.stories.mocks'
import { step } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import GateResultView from './GateResultView.vue'

// A polling gate of the login run, over the screen: CI, the merge-conflict check, a person's
// review of the pull request, or the document quality check. Each says where the gate stands,
// what failed, and what the helper agent did on each round, with the gate's budget and the gated
// commit beside it. The window reads the gate off the run's step and asks for nothing when it
// opens. The checks, commits and summaries are made up. Every button sends a request no story
// answers.

const at = Date.UTC(2026, 9, 14, 13, 0)

const prTask = {
  ...loginTask,
  status: 'pr_ready' as const,
  pullRequest: { url: 'https://example.invalid/acme/auth/pull/231', number: 231 },
}

/** The login run with `gateStep` after the coder, opened in the window. */
function opened(gateStep: Partial<PipelineStep>, run: Partial<ExecutionInstance> = {}) {
  const instance = execution({
    currentStep: 2,
    steps: [
      step({ agentKind: 'architect', state: 'done', progress: 1 }),
      step({ agentKind: 'coder', state: 'done', progress: 1 }),
      step({ agentKind: 'ci', state: 'working', progress: 0.5, ...gateStep }),
      step({ agentKind: 'merger', state: 'pending', progress: 0 }),
    ],
    ...run,
  })
  return {
    decorators: [
      withSeed(() => {
        seedSnapshot(snapshot({ blocks: boardWith(prTask), executions: [instance] }))
        seedResultView({ view: 'gate', blockId: prTask.id, instanceId: instance.id, stepIndex: 2 })
      }),
    ],
  }
}

function gate(overrides: Partial<GateStepState> = {}): GateStepState {
  return {
    phase: 'checking',
    attempts: 1,
    maxAttempts: 3,
    headSha: '9c2e4f1a7b3d5e60',
    lastVerdict: 'fail',
    ...overrides,
  }
}

const redChecks = [
  { name: 'Build & typecheck', conclusion: 'failure', url: 'https://example.invalid/runs/1' },
  { name: 'test-db', conclusion: 'timed_out', url: 'https://example.invalid/runs/2' },
]

const ciRounds: NonNullable<GateStepState['attemptLog']> = [
  {
    attempt: 1,
    at,
    outcome: 'completed',
    failingChecks: [redChecks[0]!],
    summary: 'Added the missing `revokedAt` column to the session type.',
  },
]

const meta = {
  title: 'Pipeline/Pages/GateResultView',
  component: GateResultView,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof GateResultView>
export default meta

type Story = StoryObj<typeof meta>

/**
 * CI failed again after one fixer round: the red checks, the round with what it was handed and
 * what it did, and the budget beside them.
 */
export const Default: Story = opened({
  gate: gate({ failingChecks: redChecks, attemptLog: ciRounds }),
})

/** The gate has not checked anything yet. */
export const Empty: Story = opened({})

/** CI went green with no fixer needed. */
export const Passed: Story = opened({
  state: 'done',
  progress: 1,
  gate: gate({ attempts: 0, lastVerdict: 'pass' }),
})

/** The fixer used its three rounds and CI is still red, so the run failed at this gate. */
export const GaveUp: Story = opened(
  {
    gate: gate({
      attempts: 3,
      failingChecks: [redChecks[1]!],
      attemptLog: [
        ...ciRounds,
        {
          attempt: 2,
          at: at + 15 * 60_000,
          outcome: 'completed',
          failingChecks: [redChecks[1]!],
          summary: 'Raised the test timeout for the session suite.',
        },
        {
          attempt: 3,
          at: at + 32 * 60_000,
          outcome: 'failed',
          instructions: 'test-db timed out again.',
        },
      ],
    }),
  },
  { status: 'failed' },
)

/** The branch conflicts with main, and the resolver is at work on its first round. */
export const Conflicts: Story = opened({
  agentKind: 'conflicts',
  gate: gate({
    phase: 'working',
    lastFailureSummary:
      'src/sessions/store.ts conflicts with the session TTL change merged in #228.',
  }),
})

/**
 * The pull request waits for one of two approvals, with the reviewer's comment the fixer works
 * on, and the box to ask for a fix in your own words.
 */
export const HumanReview: Story = opened({
  agentKind: 'human-review',
  state: 'waiting_decision',
  gate: gate({
    attempts: 1,
    maxAttempts: Number.MAX_SAFE_INTEGER,
    lastVerdict: 'pending',
    lastApprovals: 1,
    requiredApprovingReviewCount: 2,
    lastFailureSummary: 'Please log the session family id when a reused token revokes it.',
  }),
})

/** The document check found structural problems, listed as the gate raised them. */
export const DocQuality: Story = opened({
  agentKind: 'doc-quality',
  gate: gate({
    lastFailureSummary:
      '- The section "Rollout" has no body.\n- Two headings are both "Risks".\n' +
      '- The link to `docs/sessions.md` points at a file that does not exist.',
  }),
})
