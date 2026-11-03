// Open inbox cards on the shared board, for the stories that show the notification inbox. Each
// title and body is the backend's own wording for its type: `MergeResolver.raiseMergeReview` (the
// `class_requires_review` lead, then the scores), the CI gate's `onExhausted` in `gates.ts`,
// `PrReviewController`, and `platformHealthCardContent` in orchestration. The rationale, the
// failing-check summary and the runs are made up.
import type { Notification } from '@cat-factory/contracts'
import { loginTask, rateLimitTask } from './board.stories.mocks'

const HOUR = 3_600_000

/** An open card, raised an hour ago. */
export function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'ntf_merge_rate_limit',
    type: 'merge_review',
    status: 'open',
    blockId: null,
    executionId: null,
    title: '',
    body: '',
    createdAt: Date.now() - HOUR,
    resolvedAt: null,
    ...overrides,
  }
}

/** The rate-limit pull request, left for a person by the policy for source changes. */
export const mergeReviewCard = notification({
  id: 'ntf_merge_rate_limit',
  type: 'merge_review',
  blockId: rateLimitTask.id,
  executionId: 'exec_rate_limit',
  title: `Review PR for "${rateLimitTask.title}"`,
  body:
    "This task's merge policy asks a human to review a `source` change, so its PR was left " +
    'open regardless of the assessment. Its scores were complexity 35%, risk 40%, impact 30%. ' +
    'A sliding window per IP in the gateway, with a test for the reset. Safe to merge.',
  payload: {
    assessment: {
      complexity: 0.35,
      risk: 0.4,
      impact: 0.3,
      rationale:
        'A sliding window per IP in the gateway, with a test for the reset. Safe to merge.',
    },
    prUrl: 'https://example.invalid/acme/gateway/pull/7',
    pipelineName: 'Build',
    changeClass: 'source',
  },
})

/** The login task's CI, still red after two fixer attempts. */
export const ciFailedCard = notification({
  id: 'ntf_ci_login',
  type: 'ci_failed',
  blockId: loginTask.id,
  executionId: 'exec_login',
  title: `CI is still failing for "${loginTask.title}"`,
  body:
    'The CI-fixer agent tried 2 time(s) but CI is still red. test (node 22): 2 failing tests in ' +
    'session.spec.ts. Take a look and retry the run once fixed.',
  payload: { prUrl: 'https://example.invalid/acme/auth/pull/211', pipelineName: 'Build' },
  createdAt: Date.now() - 3 * HOUR,
})

/** The login task's pull request review, with findings to pick. */
export const prReviewCard = notification({
  id: 'ntf_review_login',
  type: 'pr_review_ready',
  blockId: loginTask.id,
  executionId: 'exec_login',
  title: `"${loginTask.title}" — 4 review findings to triage`,
  body:
    'The PR reviewer sliced the pull request and surfaced prioritized findings. Open the task ' +
    'to select which findings to act on.',
  payload: { pipelineName: 'Build', findingCount: 4, sliceCount: 3 },
  createdAt: Date.now() - 2 * HOUR,
})

/**
 * The deployment's run failure rate over the last hour, with three of its five failing runs: one
 * on the board, one whose block is known, and one that is gone.
 */
export const platformHealthCard = notification({
  id: 'ntf_platform_health',
  type: 'platform_health',
  title: 'Platform health alert',
  body:
    'The deployment shows an elevated run failure rate over the last hour. Open the operator ' +
    'dashboard for detail.',
  payload: {
    platformWindow: '1h',
    platformAlerts: ['failure_rate_high'],
    platformFailingRuns: [
      {
        executionId: 'exec_login',
        blockId: loginTask.id,
        failureKind: 'evicted',
        createdAt: Date.UTC(2026, 9, 14, 8, 10),
      },
      {
        executionId: 'exec_rate_limit_old',
        blockId: rateLimitTask.id,
        failureKind: 'dispatch',
        createdAt: Date.UTC(2026, 9, 14, 8, 25),
      },
      {
        executionId: 'exec_gone',
        blockId: null,
        failureKind: 'evicted',
        createdAt: Date.UTC(2026, 9, 14, 8, 40),
      },
    ],
    platformFailedTotal: 5,
  },
  createdAt: Date.now() - HOUR / 2,
})
