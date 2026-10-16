// Kaizen gradings: the continuous-improvement grader's verdict on one finished step, for the
// Kaizen screen and the grading status in a run window.
//
// A grading is keyed to the step's `(agentKind, model, promptVersion)` combo. Once a combo grades
// 4 or 5 with no recommendations five times in a row it is VERIFIED and no longer graded. The
// prompt versions, the grades and the recommendations are made up; the failure message is the
// backend's (`KaizenService.ts` in orchestration).
import type { KaizenGrading, KaizenVerifiedCombo } from '@cat-factory/contracts'

const MODEL = 'claude-sonnet-5-5'
const GRADER = 'anthropic:claude-haiku-5-5'

/** A complete grading of the login run's coder step: a 3, with two recommendations. */
export function kaizenGrading(overrides: Partial<KaizenGrading> = {}): KaizenGrading {
  const agentKind = overrides.agentKind ?? 'coder'
  const model = overrides.model ?? MODEL
  const promptVersion = overrides.promptVersion ?? 14
  return {
    id: 'kz_login_coder',
    executionId: 'exec_login',
    blockId: 'task_login',
    stepIndex: 1,
    agentKind,
    model,
    promptVersion,
    comboKey: `${agentKind}|${model}|${promptVersion}`,
    status: 'complete',
    grade: 3,
    summary:
      'The change landed, but the coder spent nine calls finding the session test fixtures and ' +
      'ran the same failing test command twice without an edit between the runs.',
    recommendations: [
      'Name the test fixture directory in the task description when the task touches session code.',
      'Read the failing assertion before re-running the suite; the second run repeated the first.',
    ],
    graderModel: GRADER,
    error: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgementNote: null,
    createdAt: Date.UTC(2026, 9, 11, 9, 52),
    updatedAt: Date.UTC(2026, 9, 11, 9, 53),
    ...overrides,
  }
}

/** The workspace's recent gradings, newest first: one queued, one failed and three complete. */
export const gradingHistory: KaizenGrading[] = [
  kaizenGrading({
    id: 'kz_logout_coder',
    executionId: 'exec_logout',
    blockId: 'task_logout',
    status: 'scheduled',
    grade: null,
    summary: '',
    recommendations: [],
    graderModel: null,
    createdAt: Date.UTC(2026, 9, 11, 11, 5),
    updatedAt: Date.UTC(2026, 9, 11, 11, 5),
  }),
  kaizenGrading({
    id: 'kz_rate_limit_reviewer',
    executionId: 'exec_rate_limit',
    blockId: 'task_rate_limit',
    stepIndex: 3,
    agentKind: 'reviewer',
    promptVersion: 7,
    status: 'failed',
    grade: null,
    summary: '',
    recommendations: [],
    error: 'Kaizen grader returned no parseable JSON verdict',
    createdAt: Date.UTC(2026, 9, 11, 10, 40),
    updatedAt: Date.UTC(2026, 9, 11, 10, 41),
  }),
  kaizenGrading(),
  kaizenGrading({
    id: 'kz_login_architect',
    stepIndex: 0,
    agentKind: 'architect',
    promptVersion: 9,
    grade: 5,
    summary: 'A short, grounded plan that named every file the coder later touched.',
    recommendations: [],
    createdAt: Date.UTC(2026, 9, 11, 9, 51),
    updatedAt: Date.UTC(2026, 9, 11, 9, 52),
  }),
  kaizenGrading({
    id: 'kz_refresh_reviewer',
    executionId: 'exec_refresh',
    blockId: 'task_refresh',
    stepIndex: 3,
    agentKind: 'reviewer',
    promptVersion: 7,
    grade: 5,
    summary: 'A focused review, with every finding anchored to a changed line.',
    recommendations: [],
    createdAt: Date.UTC(2026, 9, 10, 16, 20),
    updatedAt: Date.UTC(2026, 9, 10, 16, 21),
  }),
]

/**
 * The combos the gradings above left: the architect's is verified, the reviewer's has one high
 * grade towards the five, and the coder's 3 reset its count. Only a complete grading moves a
 * combo (`nextComboState` in orchestration), so the failed reviewer grading did not.
 */
export const verifiedCombos: KaizenVerifiedCombo[] = [
  {
    comboKey: `architect|${MODEL}|9`,
    agentKind: 'architect',
    model: MODEL,
    promptVersion: 9,
    consecutiveHighGrades: 5,
    verified: true,
    verifiedAt: Date.UTC(2026, 9, 11, 9, 52),
    updatedAt: Date.UTC(2026, 9, 11, 9, 52),
  },
  {
    comboKey: `reviewer|${MODEL}|7`,
    agentKind: 'reviewer',
    model: MODEL,
    promptVersion: 7,
    consecutiveHighGrades: 1,
    verified: false,
    verifiedAt: null,
    updatedAt: Date.UTC(2026, 9, 10, 16, 21),
  },
  {
    comboKey: `coder|${MODEL}|14`,
    agentKind: 'coder',
    model: MODEL,
    promptVersion: 14,
    consecutiveHighGrades: 0,
    verified: false,
    verifiedAt: null,
    updatedAt: Date.UTC(2026, 9, 11, 9, 53),
  },
]
