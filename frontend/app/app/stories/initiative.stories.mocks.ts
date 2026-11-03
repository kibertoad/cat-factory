// The Identity platform initiative over the shared board, for the stories that show an initiative:
// its planning pipeline, the entity at each stage, a planning run, the committed plan's items, the
// interview's questions, a tracked initiative with every log, and the planner's plan rendered as a
// document. The pipeline is a copy of the backend's `pl_initiative` (`seed.ts` in kernel); the
// document is rendered by the engine's own function (`renderInitiativePlanForReview` in
// contracts). The goal, the questions, the items and the plan are made up.
import {
  renderInitiativePlanForReview,
  type ExecutionInstance,
  type Initiative,
  type InitiativeItem,
  type InitiativePhase,
  type InitiativeQa,
  type Pipeline,
  type WorkspaceSnapshot,
} from '@cat-factory/contracts'
import { authInitiative, boardWithInitiative } from './board.stories.mocks'
import type { PipelineStep } from '~/types/execution'
import { approval, step } from './pipelineStep.stories.mocks'
import { snapshot } from './snapshot.stories.mocks'

export const planningPipeline: Pipeline = {
  id: 'pl_initiative',
  name: 'Plan initiative',
  purpose: 'planning',
  description:
    'Explore the codebase, interview you on what the code cannot answer, and draft a multi-phase plan for approval before committing it.',
  agentKinds: [
    'initiative-analyst',
    'initiative-interviewer',
    'initiative-planner',
    'initiative-committer',
  ],
  // The seed gates the planner: a human approves the plan before the committer stores it.
  gates: [false, false, true, false],
  builtin: true,
  version: 5,
}

const PLANNING_RUN = 'exec_identity_plan'

/** The entity behind `authInitiative`, not planned yet. */
export function initiative(overrides: Partial<Initiative> = {}): Initiative {
  return {
    id: 'ini_identity',
    blockId: authInitiative.id,
    slug: 'identity-platform',
    title: authInitiative.title,
    goal:
      'One sign-in, one session model and one audit trail across every Acme service. Retire ' +
      'the per-service session tables.',
    constraints: [],
    nonGoals: [],
    qa: [],
    interview: null,
    analysisSummary: '',
    phases: [],
    items: [],
    policy: null,
    decisions: [],
    deviations: [],
    followUps: [],
    caveats: [],
    status: 'planning',
    rev: 1,
    createdAt: Date.UTC(2026, 9, 9, 14, 0),
    updatedAt: Date.UTC(2026, 9, 11, 9, 30),
    ...overrides,
  }
}

/** A planning run at `currentStep`, with each step's state. */
export function planningRun(
  status: ExecutionInstance['status'],
  currentStep: number,
  states: PipelineStep[],
): ExecutionInstance {
  return {
    id: PLANNING_RUN,
    blockId: authInitiative.id,
    pipelineId: planningPipeline.id,
    pipelineName: planningPipeline.name,
    steps: states,
    currentStep,
    status,
  }
}

function item(
  id: string,
  title: string,
  status: InitiativeItem['status'],
  phaseId = 'ph_sessions',
): InitiativeItem {
  return { id, phaseId, title, description: '', dependsOn: [], status }
}

/** The committed plan: seven items, three settled (done or skipped). */
export const initiativeItems: InitiativeItem[] = [
  item('it_store', 'One session store for every service', 'done'),
  item('it_refresh', 'Rotate refresh tokens on use', 'done'),
  item('it_legacy_cookie', 'Keep the legacy cookie name', 'skipped'),
  item('it_logout', 'Log out everywhere', 'pr_open'),
  item('it_gateway', 'Validate sessions at the gateway', 'in_progress'),
  item('it_audit', 'One audit trail for sign-ins', 'pending', 'ph_audit'),
  item('it_retire', 'Retire the per-service session tables', 'pending', 'ph_audit'),
]

/**
 * The shared board with the initiative, its entity and, when given, its planning run. The run's
 * id is set on the initiative's block, as the engine does while a run owns it.
 */
export function initiativeSnapshot(
  entity: Initiative,
  options: { run?: ExecutionInstance; pipelines?: Pipeline[] } = {},
): WorkspaceSnapshot {
  const block = options.run ? { ...authInitiative, executionId: options.run.id } : authInitiative
  return snapshot({
    blocks: [...boardWithInitiative.filter((b) => b.id !== block.id), block],
    pipelines: options.pipelines ?? [planningPipeline],
    executions: options.run ? [options.run] : [],
    initiatives: [entity],
  })
}

/**
 * The interviewer parked the run on its questions. The park is an approval with no proposal
 * (`parkStepOnDecision` in orchestration), which no surface offers as a plan to review.
 */
export function awaitingAnswersSnapshot(): WorkspaceSnapshot {
  return initiativeSnapshot(
    initiative({ interview: { round: 1, maxRounds: 3, status: 'awaiting' } }),
    {
      run: planningRun('blocked', 1, [
        step({ agentKind: 'initiative-analyst', state: 'done', progress: 1 }),
        step({
          agentKind: 'initiative-interviewer',
          state: 'waiting_decision',
          progress: 0.5,
          approval: approval({ id: 'appr_identity_interview', proposal: '' }),
        }),
        step({ agentKind: 'initiative-planner', state: 'pending', progress: 0 }),
        step({ agentKind: 'initiative-committer', state: 'pending', progress: 0 }),
      ]),
    },
  )
}

/** The interviewer is writing its next round: nothing to answer yet. */
export function interviewingSnapshot(): WorkspaceSnapshot {
  return initiativeSnapshot(
    initiative({ interview: { round: 1, maxRounds: 3, status: 'awaiting' } }),
    {
      run: planningRun('running', 1, [
        step({ agentKind: 'initiative-analyst', state: 'done', progress: 1 }),
        step({ agentKind: 'initiative-interviewer', state: 'working', progress: 0.3 }),
        step({ agentKind: 'initiative-planner', state: 'pending', progress: 0 }),
        step({ agentKind: 'initiative-committer', state: 'pending', progress: 0 }),
      ]),
    },
  )
}

/**
 * The interview's questions after round one: two still open (the first with a suggested answer),
 * one answered and one set aside.
 */
export const interviewQuestions: InitiativeQa[] = [
  {
    id: 'qa_cutover',
    question: 'May existing sessions be signed out once during the cut-over?',
    answer: '',
    status: 'open',
    recommendation:
      'No. Keep the old sessions valid until they expire, and issue new ones from the shared ' +
      'store from day one.',
  },
  {
    id: 'qa_audit_retention',
    question: 'How long must the audit trail keep a sign-in event?',
    answer: '',
    status: 'open',
  },
  {
    id: 'qa_services',
    question: 'Which services issue their own sessions today?',
    answer: 'Auth Service and the billing portal. The gateway only validates them.',
    status: 'open',
  },
  {
    id: 'qa_social',
    question: 'Should social sign-in move to the shared session model too?',
    answer: '',
    status: 'dismissed',
  },
]

/** The two phases of the committed plan; the second pauses for review when its items settle. */
export const initiativePhases: InitiativePhase[] = [
  { id: 'ph_sessions', title: 'Session model', goal: 'One refresh token family per sign-in.' },
  {
    id: 'ph_audit',
    title: 'Audit trail',
    goal: 'Every sign-in, refresh and sign-out is recorded once.',
    checkpoint: true,
  },
]

/** The planner's plan for the initiative, as the engine renders it on the gate. */
export const initiativePlanDocument = renderInitiativePlanForReview({
  goal: 'One sign-in, one session model and one audit trail across every Acme service.',
  constraints: [
    'Existing sessions stay valid through the cut-over.',
    'The gateway keeps accepting the old cookie for 30 days.',
  ],
  nonGoals: ['Social sign-in.', 'Moving user records out of the auth database.'],
  analysisSummary:
    'The auth service already issues JWT access tokens; the gateway validates them with a ' +
    'shared key. Refresh tokens are opaque rows in `sessions` with no family or rotation.',
  phases: [
    { id: 'phase-sessions', title: 'Session model', goal: 'One refresh token family per sign-in.' },
    {
      id: 'phase-audit',
      title: 'Audit trail',
      goal: 'Every sign-in, refresh and sign-out is recorded once.',
      checkpoint: true,
      maxConcurrent: 1,
    },
  ],
  items: [
    {
      id: 'item-rotation',
      phaseId: 'phase-sessions',
      title: 'Rotate refresh tokens on use',
      description:
        'Each refresh issues a new token and revokes the one it used. A reused token revokes ' +
        'its whole family.',
      estimate: { complexity: 0.6, risk: 0.7, impact: 0.8, rationale: 'Touches every client.' },
      pipelineId: 'pl_full',
    },
    {
      id: 'item-logout',
      phaseId: 'phase-sessions',
      title: 'Log out everywhere',
      description: 'Revoke every family of a user from the account page.',
      estimate: { complexity: 0.3, risk: 0.2, impact: 0.5, rationale: '' },
      dependsOn: ['item-rotation'],
    },
    {
      id: 'item-audit-events',
      phaseId: 'phase-audit',
      title: 'Record session events',
      description: 'Write one audit row per sign-in, refresh and sign-out.',
      estimate: { complexity: 0.4, risk: 0.3, impact: 0.6, rationale: '' },
      dependsOn: ['item-rotation'],
    },
  ],
  policy: {
    maxConcurrent: 2,
    defaultPipelineId: 'pl_build',
    rules: [{ pipelineId: 'pl_full', minRisk: 0.6 }],
    onMissingEstimate: 'default',
  },
  decisions: [
    {
      title: 'Rotation before audit',
      detail: 'The audit rows name the token family, which only exists after phase 1.',
    },
  ],
  caveats: ['Mobile clients older than 4.2 store one refresh token and will be signed out once.'],
})

/**
 * The planner's draft waits at its approval gate, six minutes after the planner started.
 * `rendered` puts the plan document on it.
 */
export function planGateSnapshot({ rendered = false } = {}): WorkspaceSnapshot {
  const started = Date.UTC(2026, 9, 12, 8, 3)
  return initiativeSnapshot(
    initiative({
      status: 'awaiting_approval',
      interview: { round: 2, maxRounds: 3, status: 'done' },
    }),
    {
      run: planningRun('blocked', 2, [
        step({ agentKind: 'initiative-analyst', state: 'done', progress: 1, startedAt: started }),
        step({
          agentKind: 'initiative-interviewer',
          state: 'done',
          progress: 1,
          startedAt: started + 9 * 60_000,
        }),
        step({
          agentKind: 'initiative-planner',
          state: 'waiting_decision',
          progress: 1,
          startedAt: started + 31 * 60_000,
          pausedAt: started + 37 * 60_000,
          approval: approval({
            id: 'appr_identity_plan',
            proposal: rendered ? initiativePlanDocument : 'Two phases, seven items.',
          }),
          outputIsRendered: rendered,
        }),
        step({ agentKind: 'initiative-committer', state: 'pending', progress: 0 }),
      ]),
    },
  )
}

/**
 * The committed plan's items as the tracker sees them while the loop runs: the first two merged,
 * one skipped with the planner's note, one pull request open, one blocked, and the audit phase
 * not started. Two items name the pull request that delivered them.
 */
export const trackedItems: InitiativeItem[] = initiativeItems.map((i) => {
  switch (i.id) {
    case 'it_store':
      return { ...i, pr: { url: 'https://example.invalid/acme/auth/pull/208', number: 208 } }
    case 'it_legacy_cookie':
      return { ...i, note: 'No client reads the legacy cookie name any more.' }
    case 'it_logout':
      return {
        ...i,
        dependsOn: ['it_refresh'],
        pr: { url: 'https://example.invalid/acme/auth/pull/219', number: 219 },
      }
    case 'it_gateway':
      return { ...i, status: 'blocked', note: 'The gateway tests need a session store to run.' }
    default:
      return i
  }
})

/**
 * The initiative while its loop runs the plan: the goal, the constraints, the analysis, both
 * phases, the policy, and one entry in each log. One follow-up is open, one was promoted.
 */
export function trackedInitiative(overrides: Partial<Initiative> = {}): Initiative {
  const at = Date.UTC(2026, 9, 12, 10, 0)
  return initiative({
    status: 'executing',
    constraints: ['Existing sessions stay valid through the cut-over.'],
    nonGoals: ['Social sign-in.'],
    analysisSummary:
      'The auth service already issues JWT access tokens; the gateway validates them with a ' +
      'shared key. Refresh tokens are opaque rows in `sessions` with no family or rotation.',
    interview: { round: 2, maxRounds: 3, status: 'done' },
    phases: initiativePhases,
    items: trackedItems,
    policy: {
      maxConcurrent: 2,
      defaultPipelineId: 'pl_build',
      rules: [{ pipelineId: 'pl_full', minRisk: 0.6 }],
      onMissingEstimate: 'default',
    },
    decisions: [
      {
        id: 'dec_rotation_first',
        at,
        title: 'Rotation before audit',
        detail: 'The audit rows name the token family, which only exists after phase 1.',
        source: 'planning',
      },
    ],
    deviations: [
      {
        id: 'dev_legacy_cookie',
        at,
        itemId: 'it_legacy_cookie',
        description: 'Skipped: no client reads the legacy cookie name.',
        resolution: 'The gateway drops the old name in the same release.',
      },
    ],
    followUps: [
      {
        id: 'fu_rate_limit',
        at,
        sourceItemId: 'it_gateway',
        title: 'Rate-limit refresh calls at the gateway',
        detail: 'A stolen refresh token can be replayed until it is revoked.',
        status: 'open',
      },
      {
        id: 'fu_metrics',
        at,
        sourceItemId: 'it_store',
        title: 'Session store metrics',
        detail: '',
        status: 'promoted',
        promotedItemId: 'it_audit',
      },
    ],
    caveats: ['Mobile clients older than 4.2 store one refresh token and will be signed out once.'],
    rev: 7,
    ...overrides,
  })
}
