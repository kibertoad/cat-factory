// The Sandbox: the testable agent kinds, the prompt versions, the graded fixtures and one finished
// experiment, for the Sandbox window. The agent kinds, the baseline ids and labels and the
// built-in fixture ids and names are the real catalog's (`baselines.ts` in sandbox, `versions.ts`
// in agents, `requirements.ts` and `code-review.ts` in sandbox-fixtures). The prompt texts, the
// candidate, the custom fixture, the expected findings, the outputs and the grades are made up;
// the grade dimensions are the requirement-review rubric's (`rubrics.ts` in sandbox).
import type {
  SandboxExperiment,
  SandboxFixture,
  SandboxGrade,
  SandboxPromptVersion,
  SandboxRun,
} from '@cat-factory/contracts'
import type { SandboxAgentKindMeta } from '~/types/sandbox'

/**
 * Four of the catalog's kinds: three the Sandbox runs inline, and the coder, which it cannot,
 * because grading a pushed commit needs a container run.
 */
export const sandboxAgentKinds: SandboxAgentKindMeta[] = [
  {
    agentKind: 'requirements-review',
    label: 'Requirements review',
    bucket: 'inline',
    sandboxRun: 'inline',
    unsupportedReason: null,
    rubric: 'requirement-review',
    fixtureKinds: ['requirements'],
    basePromptId: 'requirement-review',
  },
  {
    agentKind: 'clarity-review',
    label: 'Clarity (bug-report) review',
    bucket: 'inline',
    sandboxRun: 'inline',
    unsupportedReason: null,
    rubric: 'bug-triage',
    fixtureKinds: ['clarity'],
    basePromptId: 'clarity-review',
  },
  {
    agentKind: 'reviewer',
    label: 'Code reviewer',
    bucket: 'container',
    sandboxRun: 'inline',
    unsupportedReason: null,
    rubric: 'code-review',
    fixtureKinds: ['code-review'],
    basePromptId: null,
  },
  {
    agentKind: 'coder',
    label: 'Coder (implementation)',
    bucket: 'container',
    sandboxRun: 'unsupported',
    unsupportedReason: 'container-run-required',
    rubric: 'implementation',
    fixtureKinds: ['repo-feature', 'repo-bug'],
    basePromptId: 'build',
  },
]

function promptVersion(
  overrides: Partial<SandboxPromptVersion> &
    Pick<SandboxPromptVersion, 'id' | 'agentKind' | 'name' | 'origin'>,
): SandboxPromptVersion {
  return {
    lineageId: overrides.id,
    systemText: 'You review a requirements document before any design work starts.',
    basePromptId: null,
    version: 0,
    parentId: null,
    labels: [],
    createdAt: Date.UTC(2026, 9, 1),
    createdBy: null,
    archivedAt: null,
    ...overrides,
  }
}

/** The shipped requirements-review prompt, as the Sandbox lists it. */
export const requirementsBaseline = promptVersion({
  id: 'baseline:requirement-review',
  agentKind: 'requirements-review',
  name: 'requirement-review@v6',
  origin: 'baseline',
  basePromptId: 'requirement-review',
})

/** The second version of a candidate that asks for edge cases first. */
export const requirementsCandidate = promptVersion({
  id: 'sp_edge_v2',
  lineageId: 'sp_edge_v1',
  agentKind: 'requirements-review',
  name: 'Edge cases first',
  origin: 'candidate',
  systemText:
    'You review a requirements document before any design work starts. List the edge cases ' +
    'the document does not answer before anything else, most costly first.',
  basePromptId: 'requirement-review',
  version: 2,
  parentId: 'sp_edge_v1',
  labels: ['edge-cases'],
  createdAt: Date.UTC(2026, 9, 8),
  createdBy: 'user_ada',
})

/** Every prompt version: the baselines, the candidate, and the board's own reviewer prompt, live. */
export const sandboxPrompts: SandboxPromptVersion[] = [
  requirementsBaseline,
  requirementsCandidate,
  promptVersion({
    id: 'baseline:clarity-review',
    agentKind: 'clarity-review',
    name: 'clarity-review@v2',
    origin: 'baseline',
    basePromptId: 'clarity-review',
  }),
  promptVersion({
    id: 'baseline:reviewer',
    agentKind: 'reviewer',
    name: 'reviewer@v1',
    origin: 'baseline',
  }),
  promptVersion({
    id: 'workspace:reviewer:3',
    lineageId: 'workspace:reviewer',
    agentKind: 'reviewer',
    name: 'Code reviewer',
    origin: 'workspace',
    version: 3,
    live: true,
    createdAt: Date.UTC(2026, 9, 5),
    createdBy: 'user_ada',
  }),
  promptVersion({
    id: 'baseline:build',
    agentKind: 'coder',
    name: 'build@v8',
    origin: 'baseline',
    basePromptId: 'build',
  }),
]

/**
 * A fixture with `expectations` made-up findings, each of impact 3. The 1-based positions in
 * `highImpact` get impact 4, the backend's high-impact threshold, so missing one fails the run.
 */
function fixture(
  overrides: Partial<SandboxFixture> & Pick<SandboxFixture, 'id' | 'kind' | 'name'>,
  expectations: number,
  highImpact: number[] = [],
): SandboxFixture {
  return {
    payload: { block: { title: overrides.name, type: 'service', description: '' } },
    repoRef: null,
    objective: {
      kind: 'findings',
      expectations: Array.from({ length: expectations }, (_, i) => ({
        id: `expectation-${i + 1}`,
        summary: `Expected finding ${i + 1}`,
        detail: '',
        trickiness: 2,
        impact: highImpact.includes(i + 1) ? 4 : 3,
        matchHints: [],
      })),
    },
    origin: 'builtin',
    createdAt: Date.UTC(2026, 9, 1),
    ...overrides,
  }
}

/** Two built-in requirements fixtures and a custom one, and a built-in code-review fixture. */
export const sandboxFixtures: SandboxFixture[] = [
  fixture(
    {
      id: 'req-notify-prefs-simple',
      kind: 'requirements',
      name: 'Notification preferences (simple)',
    },
    4,
    // The third finding is whether security alerts can be muted, the one a reviewer must not miss.
    [3],
  ),
  fixture(
    { id: 'req-csv-export-moderate', kind: 'requirements', name: 'CSV export (moderate)' },
    5,
  ),
  fixture(
    {
      id: 'sf_sso_rollout',
      kind: 'requirements',
      name: 'SSO rollout for Acme',
      origin: 'custom',
      objective: null,
      createdAt: Date.UTC(2026, 9, 6),
    },
    0,
  ),
  fixture(
    { id: 'review-token-bucket-simple', kind: 'code-review', name: 'Rate limiter (simple)' },
    3,
  ),
]

/** The candidate against the baseline on two models and the two built-in fixtures, graded. */
export const sandboxExperiment: SandboxExperiment = {
  id: 'sx_edge_vs_baseline',
  name: 'Edge cases first vs baseline',
  agentKind: 'requirements-review',
  judgeModel: 'anthropic:claude-opus-5',
  repeats: 1,
  status: 'done',
  matrix: {
    promptVersionIds: [requirementsBaseline.id, requirementsCandidate.id],
    models: ['claude-opus', 'kimi-k2.7'],
    fixtureIds: ['req-notify-prefs-simple', 'req-csv-export-moderate'],
  },
  budgetTokens: null,
  createdAt: Date.UTC(2026, 9, 9, 14),
  createdBy: 'user_ada',
}

/** Older experiments: one that failed and one never run. */
export const olderSandboxExperiments: SandboxExperiment[] = [
  {
    ...sandboxExperiment,
    id: 'sx_reviewer_models',
    name: 'Reviewer on three models',
    agentKind: 'reviewer',
    status: 'failed',
    matrix: {
      promptVersionIds: ['workspace:reviewer:3'],
      models: ['claude-opus', 'kimi-k2.7', 'glm-5.3'],
      fixtureIds: ['review-token-bucket-simple'],
    },
    createdAt: Date.UTC(2026, 9, 7, 10),
  },
  {
    ...sandboxExperiment,
    id: 'sx_sso_draft',
    name: 'SSO rollout check',
    status: 'draft',
    matrix: {
      promptVersionIds: [requirementsCandidate.id],
      models: ['claude-opus'],
      fixtureIds: ['sf_sso_rollout'],
    },
    createdAt: Date.UTC(2026, 9, 6, 16),
  },
]

const NOTIFY_OUTPUT =
  '1. Which channels does the toggle govern: email, push, in-app?\n' +
  '2. What is the default for a new user?\n' +
  '3. Can a user mute security alerts and password resets?'

/** The candidate asks about the security alerts first, then the rest. */
const CANDIDATE_NOTIFY_OUTPUT =
  '1. Can a user mute security alerts and password resets?\n' +
  '2. Which channels does the toggle govern: email, push, in-app?\n' +
  '3. What is the default for a new user?\n' +
  '4. Does muting a channel also stop the digest e-mail?'

const CSV_OUTPUT =
  '1. Which columns does the export include, and in what order?\n' +
  '2. Is the export filtered by the list view, or does it hold every row?\n' +
  '3. Who may export: every member, or admins only?'

/** The candidate adds the size limit to the baseline's three, and still misses the encoding. */
const CANDIDATE_CSV_OUTPUT = `${CSV_OUTPUT}\n4. What is the largest export, in rows, before it is sent by e-mail?`

function run(
  id: string,
  prompt: SandboxPromptVersion,
  model: string,
  fixtureId: string,
  overrides: Partial<SandboxRun> = {},
): SandboxRun {
  return {
    id,
    experimentId: sandboxExperiment.id,
    promptVersionId: prompt.id,
    model,
    fixtureId,
    repeatIndex: 0,
    status: 'done',
    outputText: fixtureId === 'req-csv-export-moderate' ? CSV_OUTPUT : NOTIFY_OUTPUT,
    usage: { inputTokens: 3_820, outputTokens: 610 },
    latencyMs: 14_200,
    branch: null,
    prUrl: null,
    diff: null,
    error: null,
    seedSha: null,
    promptLabel: prompt.origin === 'baseline' ? prompt.name : `${prompt.name}@v${prompt.version}`,
    startedAt: Date.UTC(2026, 9, 9, 14, 1),
    finishedAt: Date.UTC(2026, 9, 9, 14, 2),
    ...overrides,
  }
}

/** Every cell of the matrix: two prompts, two models and two fixtures. */
const runs: SandboxRun[] = [
  // The baseline asks about the channels and the default, and never about security alerts.
  run('sr_1', requirementsBaseline, 'claude-opus', 'req-notify-prefs-simple', {
    outputText:
      '1. Which channels does the toggle govern: email, push, in-app?\n' +
      '2. What is the default for a new user?',
  }),
  run('sr_2', requirementsBaseline, 'kimi-k2.7', 'req-csv-export-moderate'),
  run('sr_3', requirementsCandidate, 'claude-opus', 'req-notify-prefs-simple', {
    outputText: CANDIDATE_NOTIFY_OUTPUT,
  }),
  run('sr_4', requirementsCandidate, 'kimi-k2.7', 'req-csv-export-moderate', {
    status: 'failed',
    outputText: null,
    usage: null,
    error: 'Workers AI answered 429: the account is over its rate limit.',
  }),
  run('sr_5', requirementsBaseline, 'claude-opus', 'req-csv-export-moderate'),
  run('sr_6', requirementsBaseline, 'kimi-k2.7', 'req-notify-prefs-simple'),
  run('sr_7', requirementsCandidate, 'claude-opus', 'req-csv-export-moderate', {
    outputText: CANDIDATE_CSV_OUTPUT,
  }),
  run('sr_8', requirementsCandidate, 'kimi-k2.7', 'req-notify-prefs-simple', {
    outputText: CANDIDATE_NOTIFY_OUTPUT,
  }),
]

/**
 * The judge's grade of `runId` with the objective result the backend computes from its fixture:
 * `missed` names the expectations the output did not catch (1-based positions), and a missed
 * expectation of impact 4 or more fails the run (`scoreExpectations`, `sandbox.logic.ts`).
 */
function grade(
  runId: string,
  weightedTotal: number,
  missed: number[],
  scores: SandboxGrade['scores'],
): SandboxGrade {
  const fixtureId = runs.find((r) => r.id === runId)!.fixtureId
  const objective = sandboxFixtures.find((f) => f.id === fixtureId)?.objective
  if (objective?.kind !== 'findings') throw new Error(`Fixture ${fixtureId} has no findings`)
  const { expectations } = objective
  const missedRows = expectations.filter((_, i) => missed.includes(i + 1))
  const total = expectations.length
  const caught = total - missedRows.length
  const totalImpact = expectations.reduce((sum, e) => sum + e.impact, 0)
  const missedImpact = missedRows.reduce((sum, e) => sum + e.impact, 0)
  const impactRecall = Math.round((1 - missedImpact / totalImpact) * 100) / 100
  const missedHighImpact = missedRows.filter((e) => e.impact >= 4).map((e) => e.id)
  return {
    id: `sg_${runId}`,
    runId,
    judgeModel: 'anthropic:claude-opus-5',
    scores,
    weightedTotal,
    objective: {
      kind: 'findings',
      pass: missedHighImpact.length === 0,
      detail: `Caught ${caught}/${total} expected findings; impact recall ${impactRecall}, wow bonus 1.`,
      impactRecall,
      // No expectation is tricky enough to count, so the bonus is the backend's default of 1.
      wowBonus: 1,
      caught,
      total,
      missedHighImpact,
    },
    createdAt: Date.UTC(2026, 9, 9, 14, 3),
  }
}

/** The finished experiment: eight cells, seven graded and one failed. */
export const sandboxExperimentDetail = {
  experiment: sandboxExperiment,
  runs,
  grades: [
    grade(
      'sr_1',
      3.4,
      [3],
      [
        {
          key: 'gap_coverage',
          score: 3,
          rationale: 'Misses whether security alerts can be muted.',
        },
        { key: 'specificity', score: 4, rationale: 'Each question names the field it is about.' },
      ],
    ),
    grade(
      'sr_2',
      2.6,
      [4, 5],
      [
        {
          key: 'gap_coverage',
          score: 2,
          rationale: 'Asks nothing about the size limit or encoding.',
        },
        { key: 'specificity', score: 3, rationale: 'Two questions are generic.' },
      ],
    ),
    grade(
      'sr_3',
      4.6,
      [],
      [
        { key: 'gap_coverage', score: 5, rationale: 'Finds all four, the security alerts first.' },
        { key: 'specificity', score: 4, rationale: 'Each question names the field it is about.' },
      ],
    ),
    grade(
      'sr_5',
      3.0,
      [4, 5],
      [
        {
          key: 'gap_coverage',
          score: 3,
          rationale: 'Asks nothing about the size limit or encoding.',
        },
        { key: 'specificity', score: 3, rationale: 'The permission question names no role.' },
      ],
    ),
    grade(
      'sr_6',
      3.6,
      [4],
      [
        { key: 'gap_coverage', score: 4, rationale: 'Asks about security alerts, but last.' },
        { key: 'specificity', score: 3, rationale: 'The channel question lists no channel.' },
      ],
    ),
    grade(
      'sr_7',
      4.1,
      [5],
      [
        { key: 'gap_coverage', score: 4, rationale: 'Misses only the file encoding.' },
        { key: 'specificity', score: 4, rationale: 'Each question names the field it is about.' },
      ],
    ),
    grade(
      'sr_8',
      4.4,
      [],
      [
        { key: 'gap_coverage', score: 5, rationale: 'Finds all four, the security alerts first.' },
        { key: 'specificity', score: 4, rationale: 'One question could name the digest setting.' },
      ],
    ),
  ],
}
