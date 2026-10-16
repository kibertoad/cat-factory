// A finished run of the login task, with every kind of evidence the outcome summary reads: the
// pages the agents read, the tester's report and its screenshots, the environment the run stood
// up, the CI gate and the validation command, and the spec the run was judged against. Built
// from the shared board and tester fixtures; the spec, the pages and the URLs are made up.
import type {
  ExecutionInstance,
  PipelineStep,
  RequirementItem,
  ServiceSpecView,
  StepContextDocument,
  TestReport,
} from '@cat-factory/contracts'
import { authService, loginTask } from './board.stories.mocks'
import { step } from './pipelineStep.stories.mocks'
import { buildPipeline } from './snapshot.stories.mocks'
import { validationPassed } from './stepReports.stories.mocks'
import { testerState, testReport } from './testing.stories.mocks'
import type { Block } from '~/types/domain'

export const OUTCOME_RUN_ID = 'exec_login'

/** The two captured views of the sign-in page, as artifact ids the blob read answers. */
export const SIGN_IN_SHOT = 'art_shot_sign_in'
export const SESSIONS_SHOT = 'art_shot_sessions'

function requirement(id: string, title: string, state: RequirementItem['state']): RequirementItem {
  return {
    id,
    title,
    statement: `The system SHALL ${title.toLowerCase()}.`,
    kind: 'functional',
    priority: 'must',
    state,
    sourceBlockIds: [],
    acceptance: [],
  }
}

/**
 * The spec on the run's branch: signing in and logging out everywhere are established, and the
 * audit entry is new with this task. The ids are the ones `testReport()` rules on.
 */
export const runSpec: ServiceSpecView = {
  present: true,
  spec: {
    service: 'Auth Service',
    summary: 'Signs people in, keeps their sessions alive and ends them.',
    modules: [
      {
        name: 'Sessions',
        summary: '',
        groups: [
          {
            name: 'Sign-in',
            summary: '',
            requirements: [
              requirement('req-login', 'Sign a user in with a password', 'established'),
              requirement(
                'req-logout-all',
                'End every session when the user logs out everywhere',
                'established',
              ),
              requirement('req-audit', 'Record each sign-in in the audit log', 'aspirational'),
            ],
            rules: [],
          },
        ],
      },
    ],
  },
  features: [],
}

/** What the coder and the tester read: the session spec, and the sign-in design. */
const pages: StepContextDocument[] = [
  {
    title: 'Session lifecycle',
    externalId: '48213377',
    url: 'https://acme.atlassian.net/wiki/spaces/AUTH/pages/48213377',
    origin: 'confluence',
    freshness: { status: 'confirmed', version: '14', change: 'unchanged' },
  },
  {
    title: 'Sign in, all states',
    externalId: 'Xq3hT9mPa2Lk:1204:88',
    url: 'https://www.figma.com/design/Xq3hT9mPa2Lk?node-id=1204-88',
    origin: 'figma',
    freshness: { status: 'unconfirmed', reason: 'source_unreachable' },
  },
]

/** A passing report: every area works, one low concern, and the audit entry not exercised. */
export const passingReport: TestReport = testReport({
  greenlight: true,
  summary: 'Sign-in, refresh and log out everywhere all work in the preview environment.',
  outcomes: [
    { name: 'Sign in and refresh', status: 'passed' },
    { name: 'Expired refresh token answers 401', status: 'passed' },
    { name: 'Log out everywhere', status: 'passed' },
  ],
  concerns: [{ title: 'Error copy names the token type', detail: '', severity: 'low' }],
  requirementVerdicts: [
    { requirementId: 'req-login', status: 'met' },
    { requirementId: 'req-logout-all', status: 'met' },
    { requirementId: 'req-audit', status: 'not_covered' },
  ],
  environment: 'ephemeral',
  screenshots: [
    { view: 'Sign in', artifactId: SIGN_IN_SHOT },
    { view: 'Active sessions', artifactId: SESSIONS_SHOT },
  ],
})

/** The preview environment of pull request 212, where the login run's checks ran. */
export const PREVIEW_ENV_ID = 'env_212'
export const PREVIEW_ENV_URL = 'https://login-pr-212.preview.acme.dev'

/** The run's steps, with `report` on the tester and the CI gate at `ci`. */
function steps(report: TestReport, ci: 'pass' | 'fail'): PipelineStep[] {
  return [
    step({ agentKind: 'architect', state: 'done', progress: 1 }),
    step({ agentKind: 'coder', state: 'done', progress: 1, contextDocuments: pages }),
    step({
      agentKind: 'deployer',
      state: 'done',
      progress: 1,
      deployEnvs: {
        [authService.id]: { status: 'ready', url: PREVIEW_ENV_URL, environmentId: PREVIEW_ENV_ID },
      },
    }),
    step({
      agentKind: 'tester-ui',
      state: 'done',
      progress: 1,
      contextDocuments: pages,
      test: testerState({ phase: 'testing', lastReport: report }),
      validation: validationPassed,
      environment: {
        id: PREVIEW_ENV_ID,
        url: PREVIEW_ENV_URL,
        status: 'ready',
        expiresAt: Date.UTC(2026, 9, 16, 18, 0),
      },
    }),
    step({
      agentKind: 'ci',
      state: ci === 'pass' ? 'done' : 'working',
      progress: ci === 'pass' ? 1 : 0.5,
      gate: {
        phase: ci === 'pass' ? 'checking' : 'working',
        attempts: 1,
        maxAttempts: 3,
        lastVerdict: ci,
      },
    }),
  ]
}

/** The run that passed, waiting for its pull request to merge. */
export const passedRun: ExecutionInstance = {
  id: OUTCOME_RUN_ID,
  blockId: loginTask.id,
  pipelineId: buildPipeline.id,
  pipelineName: buildPipeline.name,
  steps: steps(passingReport, 'pass'),
  currentStep: 4,
  status: 'done',
}

/**
 * The run that failed: the tester's own report (log out everywhere fails, which the spec says
 * already worked), and CI red.
 */
export const failedRun: ExecutionInstance = {
  ...passedRun,
  steps: steps(testReport({ environment: 'ephemeral' }), 'fail'),
  status: 'failed',
}

const ask =
  'Add **log out everywhere** to the account menu. It ends every session of the user, on every ' +
  'device, and records the sign-out in the audit log.'

/** The login task with the run, its pull request, and what was asked. */
export function outcomeTask(overrides: Partial<Block> = {}): Block {
  return {
    ...loginTask,
    description: ask,
    executionId: OUTCOME_RUN_ID,
    status: 'pr_ready',
    pullRequest: {
      url: 'https://github.com/acme/auth-service/pull/212',
      number: 212,
      branch: 'cat/login-logout-everywhere',
    },
    ...overrides,
  }
}
