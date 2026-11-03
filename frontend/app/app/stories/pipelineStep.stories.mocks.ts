// Shared story fixtures for a `PipelineStep`.
//
// Three components read a step and none of them reads the same part: `AgentChip` wants the state
// ring, `PrReviewPhaseBadge` wants `prReview` plus `subtasks`, `StepExecutionHistory` wants the
// attempt trail. A local mock in each would be three descriptions of one type drifting apart, so
// it lives here, in the shape the autopilot conventions call a scenario primitive.
//
// Only four fields are required by the contract (`agentKind`, `state`, `progress`, `decision`);
// everything else is optional and a story adds what it needs. Keeping the base MINIMAL is the
// point: a fixture that fills every field teaches the next reader that every field is needed.
import type {
  CompanionVerdict,
  Decision,
  PrReviewStatus,
  PrReviewStepState,
  RunInputGate,
  StepApproval,
} from '@cat-factory/contracts'
import type { AgentFailure, PriorStepOutput } from '~/types/domain'
import type { PipelineStep, StepSubtasks } from '~/types/execution'

/** The smallest step the contract accepts, with the parts a story cares about overridable. */
export function step(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    agentKind: 'coder',
    state: 'working',
    // 0..1. The pipeline view multiplies by 100.
    progress: 0.4,
    decision: null,
    ...overrides,
  }
}

/** A slice plan: `total` 0 is what the pr-review phase reads as "no plan yet". */
export function subtasks(completed: number, total: number, inProgress = 0): StepSubtasks {
  return { completed, inProgress, total }
}

/**
 * A pr-review state at `status`. The arrays and counters are not optional on the type: the schema
 * defaults them on parse, so every persisted state carries them.
 */
export function prReview(status: PrReviewStatus): PrReviewStepState {
  return {
    status,
    slices: [],
    sliceReviews: [],
    resumeAttempts: 0,
    findings: [],
    selectedFindingIds: [],
    postedFindingIds: [],
    postedBody: false,
    postAttempts: 0,
  }
}

/** One recorded failure on a superseded attempt. */
export function failure(overrides: Partial<AgentFailure> = {}): AgentFailure {
  return {
    kind: 'evicted',
    message: 'The container was lost mid-run.',
    detail: 'exit code 137\nkilled: out of memory after 4m12s',
    hint: 'Check the container logs for this job id.',
    occurredAt: Date.UTC(2026, 9, 11, 9, 32, 0),
    lastSubtasks: null,
    stepIndex: 2,
    ...overrides,
  }
}

/** What a superseded attempt PRODUCED, which the history shows beside what went wrong. */
export function priorOutput(overrides: Partial<PriorStepOutput> = {}): PriorStepOutput {
  return {
    stepIndex: 2,
    occurredAt: Date.UTC(2026, 9, 11, 9, 18, 0),
    output: 'Added a single-flight lock around the token refresh. Two tests still fail.',
    ...overrides,
  }
}

/** A gate waiting on a person, with the summary the step parked on as its `proposal`. */
export function approval(overrides: Partial<StepApproval> = {}): StepApproval {
  return {
    id: 'appr_login_plan',
    status: 'pending',
    proposal:
      'Add a refresh token rotation to the login flow. Each refresh issues a new token and ' +
      'revokes the old one; a reused token revokes the whole session family.',
    ...overrides,
  }
}

/**
 * A question the architect raised on the login plan, not yet answered. The question and the
 * options are made up.
 */
export function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'dec_session_store',
    question: 'Where should the refresh lock live?',
    options: ['Redis, beside the session cache', 'A Postgres advisory lock', 'In process only'],
    chosen: null,
    ...overrides,
  }
}

/** Two rounds from the architect's companion: the first under the bar, the second held by a blocker. */
export const companionVerdicts: CompanionVerdict[] = [
  {
    rating: 0.58,
    threshold: 0.75,
    passed: false,
    feedback: 'The plan does not say what happens to a token already in flight.',
    comments: [{ body: 'Name the rollout order for the two regions.', severity: 'minor' }],
  },
  {
    rating: 0.82,
    threshold: 0.75,
    passed: false,
    feedback: 'Clearer. One point still holds the plan.',
    comments: [
      {
        body: 'A reused token must revoke the **whole** family, not one token.',
        severity: 'blocker',
      },
      { body: 'Say where the lock lives.', severity: 'major' },
    ],
  },
]

/**
 * The check before dispatch blocked a task of a custom incident type with two required fields:
 * two blocking findings and one advisory (`descriptionFinding` and `customFieldFindings` in
 * kernel's `input-gate.ts`). The type and its fields are made up.
 */
export const blockedInputGate: RunInputGate = {
  status: 'blocked',
  mode: 'standard',
  checkedAt: Date.UTC(2026, 9, 11, 9, 30),
  issues: [
    { code: 'description_thin', severity: 'advisory' },
    {
      code: 'required_field_missing',
      severity: 'blocking',
      field: { key: 'severity', label: 'Incident severity' },
    },
    {
      code: 'required_field_missing',
      severity: 'blocking',
      field: { key: 'service', label: 'Affected service' },
    },
  ],
}
