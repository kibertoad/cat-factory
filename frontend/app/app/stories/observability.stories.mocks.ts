// Run observability: the LLM call rollup of one pipeline step, for the step metrics bar and the
// model activity section that wraps it, and the login run's telemetry for the panel that reads it
// whole: its model calls, its tool calls, the context each agent was given and its web searches.
// The tool names are the harness's (`progress-guard.ts`); the sessions and figures are made up.
import type {
  AgentContextSnapshot,
  AgentSearchQuery,
  AgentToolCall,
  LlmCallMetric,
  RunToolCallFailures,
  StepMetrics,
  StepPhaseMetrics,
} from '@cat-factory/contracts'
import { STORY_WORKSPACE_ID } from './workspace'

/**
 * A coder step's calls: 42 calls, most input served from the prompt cache, a peak reply at about
 * two thirds of the output limit, and a cost in euros. The figures are made up.
 */
export function stepMetrics(overrides: Partial<StepMetrics> = {}): StepMetrics {
  return {
    calls: 42,
    promptTokens: 186_400,
    cacheReadTokens: 2_914_000,
    cacheWriteTokens: 241_300,
    completionTokens: 58_900,
    peakCompletionTokens: 21_300,
    maxOutputTokens: 32_000,
    truncatedCalls: 0,
    upstreamMs: 612_000,
    overheadMs: 18_400,
    errors: 0,
    warnings: 0,
    costEstimate: 4.82,
    costCurrency: 'EUR',
    ...overrides,
  }
}

// ---- The login run's tool calls ---------------------------------------------------------

const JOB = 'exec_login-coder'
const START = Date.UTC(2026, 9, 11, 9, 14, 0)

let clock = START

/** The next call in the coder's dispatch, `ms` long, with its arguments as JSON. */
function call(
  seq: number,
  tool: string,
  args: Record<string, unknown>,
  result: string,
  overrides: Partial<AgentToolCall> & { ms?: number } = {},
): AgentToolCall {
  const { ms = 400, ...rest } = overrides
  const startedAt = clock
  clock += ms + 1_500
  return {
    id: `tc_login_${seq}`,
    workspaceId: STORY_WORKSPACE_ID,
    executionId: 'exec_login',
    agentKind: 'coder',
    jobId: JOB,
    seq,
    tool,
    startedAt,
    endedAt: startedAt + ms,
    ok: true,
    bodies: 'stored',
    args: JSON.stringify(args),
    result,
    argsDropped: 0,
    resultDropped: 0,
    createdAt: startedAt + ms,
    ...rest,
  }
}

const failingTest =
  'FAIL  src/session/refresh.spec.ts > refresh > rotates the refresh token\n' +
  'AssertionError: expected "rt_1" not to be "rt_1"\n' +
  '\n' +
  'Test Files  1 failed | 3 passed (4)\n' +
  '     Tests  1 failed | 27 passed (28)'

/**
 * The coder reads the refresh path, edits it, and runs the tests twice before they pass. The
 * first run fails, and the second edit fixes it.
 */
export const loginToolCalls: AgentToolCall[] = [
  call(
    0,
    'read',
    { path: 'src/session/refresh.ts' },
    'export async function refresh(token: string) {…',
    { ms: 20 },
  ),
  call(
    1,
    'grep',
    { pattern: 'rotateRefresh', path: 'src' },
    'src/session/store.ts:41: export function rotateRefresh(',
    { ms: 90 },
  ),
  call(
    2,
    'edit',
    {
      path: 'src/session/refresh.ts',
      oldText: 'return issue(session)',
      newText: 'return issue(rotateRefresh(session))',
    },
    'Applied 1 edit.',
    { ms: 30 },
  ),
  call(3, 'bash', { command: 'pnpm vitest run src/session' }, failingTest, {
    ms: 8_400,
    ok: false,
  }),
  call(
    4,
    'read',
    { path: 'src/session/store.ts' },
    'export function rotateRefresh(session: Session) {…',
    { ms: 20 },
  ),
  call(
    5,
    'edit',
    {
      path: 'src/session/store.ts',
      oldText: 'refreshToken: session.refreshToken',
      newText: 'refreshToken: mintRefreshToken()',
    },
    'Applied 1 edit.',
    { ms: 30 },
  ),
  call(
    6,
    'bash',
    { command: 'pnpm vitest run src/session' },
    'Test Files  4 passed (4)\n     Tests  28 passed (28)',
    { ms: 7_900 },
  ),
]

/** The run-level failure read over the session above: seven calls, one failed. */
export const loginToolFailures: RunToolCallFailures = {
  total: loginToolCalls.length,
  failed: loginToolCalls.filter((c) => !c.ok).length,
  failures: loginToolCalls.filter((c) => !c.ok),
  failuresTruncated: false,
}

// ---- The login run's model calls ---------------------------------------------------------

const CALLS_START = Date.UTC(2026, 9, 11, 9, 2, 0)

/** One model call of the login run, served by the gateway. A plain, successful turn by default. */
export function llmCall(overrides: Partial<LlmCallMetric> = {}): LlmCallMetric {
  return {
    id: 'llm_login_0',
    workspaceId: STORY_WORKSPACE_ID,
    executionId: 'exec_login',
    agentKind: 'coder',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-5.5',
    upstreamProvider: null,
    createdAt: CALLS_START,
    streaming: true,
    phase: 'agent',
    turnIndex: 0,
    spendOnly: false,
    messageCount: 4,
    toolCount: 12,
    requestMaxTokens: 32_000,
    promptTokens: 3_200,
    cacheReadTokens: 41_800,
    cacheWriteTokens: 0,
    completionTokens: 1_150,
    totalTokens: 46_150,
    finishReason: 'tool_calls',
    upstreamMs: 9_400,
    overheadMs: 180,
    totalMs: 9_580,
    ok: true,
    httpStatus: 200,
    errorMessage: null,
    promptText: JSON.stringify([
      { role: 'user', content: 'Rotate the refresh token on every use.' },
    ]),
    promptPrefixCount: 3,
    promptHash: '',
    responseText: 'I will read the refresh path first.',
    reasoningText: '',
    reportedCostUsd: 0.0214,
    ...overrides,
  }
}

/**
 * The run's calls, newest first as the endpoint sends them: the architect's plan, then the coder's
 * loop, with one reply cut short by the output limit. All of them succeeded.
 */
export const loginCalls: LlmCallMetric[] = [
  llmCall({
    id: 'llm_login_4',
    turnIndex: 3,
    createdAt: CALLS_START + 9 * 60_000,
    phase: 'validation-repair',
    promptTokens: 2_100,
    cacheReadTokens: 58_300,
    completionTokens: 900,
    finishReason: 'stop',
    responseText: 'The tests pass. The refresh token now rotates on every use.',
  }),
  llmCall({
    id: 'llm_login_3',
    turnIndex: 2,
    createdAt: CALLS_START + 6 * 60_000,
    promptTokens: 1_800,
    cacheReadTokens: 52_100,
    cacheWriteTokens: 6_400,
    completionTokens: 32_000,
    finishReason: 'length',
    upstreamMs: 61_200,
    totalMs: 61_420,
    overheadMs: 220,
    responseText: 'Here is the whole store rewritten with rotation on every call path…',
  }),
  llmCall({
    id: 'llm_login_2',
    turnIndex: 1,
    createdAt: CALLS_START + 3 * 60_000,
    cacheReadTokens: 44_900,
  }),
  llmCall({ id: 'llm_login_1' }),
  llmCall({
    id: 'llm_login_0',
    agentKind: 'architect',
    phase: '',
    turnIndex: null,
    createdAt: CALLS_START - 4 * 60_000,
    streaming: false,
    messageCount: 2,
    toolCount: 0,
    promptTokens: 8_600,
    cacheReadTokens: 0,
    completionTokens: 2_400,
    finishReason: 'stop',
    upstreamMs: 21_000,
    totalMs: 21_150,
    overheadMs: 150,
    promptPrefixCount: 0,
    responseText: 'Plan: mint a new refresh token in the session store on every refresh.',
    reasoningText: 'The store owns the token, so the rotation belongs there.',
  }),
]

/** A call the gateway refused for its rate limit, as the run's coder saw it. */
export const rateLimitedCall = llmCall({
  id: 'llm_login_5',
  turnIndex: 4,
  createdAt: CALLS_START + 11 * 60_000,
  ok: false,
  httpStatus: 429,
  errorMessage: 'Rate limit exceeded for anthropic/claude-sonnet-5.5. Retry after 20 seconds.',
  finishReason: null,
  promptTokens: 0,
  cacheReadTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  upstreamMs: 0,
  overheadMs: 340,
  totalMs: 340,
  responseText: '',
  reportedCostUsd: null,
})

/** Where the login run's tokens went: the coder's loop, its repair round, and the architect. */
export const loginPhases: StepPhaseMetrics[] = [
  {
    phase: 'agent',
    calls: 3,
    promptTokens: 8_200,
    cacheReadTokens: 138_800,
    cacheWriteTokens: 6_400,
    completionTokens: 34_300,
    carryCostTokens: 412_000,
    errors: 0,
    costEstimate: 1.38,
  },
  {
    phase: 'validation-repair',
    calls: 1,
    promptTokens: 2_100,
    cacheReadTokens: 58_300,
    cacheWriteTokens: 0,
    completionTokens: 900,
    carryCostTokens: 61_300,
    errors: 0,
    costEstimate: 0.22,
  },
  {
    phase: '',
    calls: 1,
    promptTokens: 8_600,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 2_400,
    carryCostTokens: 11_000,
    errors: 0,
    costEstimate: 0.09,
  },
]

// ---- What the login run's agents were given, and what they searched ------------------------

/** The context each container agent of the login run was given. */
export const loginContext: AgentContextSnapshot[] = [
  {
    id: 'ctx_login_coder',
    workspaceId: STORY_WORKSPACE_ID,
    executionId: 'exec_login',
    agentKind: 'coder',
    stepIndex: 1,
    createdAt: CALLS_START - 30_000,
    model: 'openrouter:anthropic/claude-sonnet-5.5',
    harness: 'claude-code',
    systemPrompt: 'You are the coder. Implement the approved plan in the checked-out repository.',
    userPrompt:
      'Task: Login endpoint\n\nRotate the refresh token on every use, and revoke the session when a ' +
      'used token comes back.',
    fragments: [
      {
        id: 'testing/vitest',
        body: 'Run the narrowest test file first. Do not mock the module under test.',
      },
    ],
    contextFiles: [
      {
        path: 'session-design.md',
        title: 'Session design',
        url: 'https://acme.atlassian.net/wiki/spaces/AUTH/pages/4821',
        content: 'A session holds one refresh token. A refresh issues a new one.',
      },
    ],
    extras: { attempt: 1, reviewRound: 0 },
  },
  {
    id: 'ctx_login_architect',
    workspaceId: STORY_WORKSPACE_ID,
    executionId: 'exec_login',
    agentKind: 'architect',
    stepIndex: 0,
    createdAt: CALLS_START - 5 * 60_000,
    model: 'openrouter:anthropic/claude-sonnet-5.5',
    harness: null,
    systemPrompt: 'You are the architect. Plan the change before any code is written.',
    userPrompt: 'Task: Login endpoint',
    fragments: [],
    contextFiles: [],
    extras: {},
  },
]

/** The web searches the login run's agents made. */
export const loginSearches: AgentSearchQuery[] = [
  {
    id: 'sq_login_2',
    workspaceId: STORY_WORKSPACE_ID,
    executionId: 'exec_login',
    agentKind: 'coder',
    provider: 'searxng',
    query: 'refresh token rotation reuse detection',
    resultCount: 8,
    createdAt: CALLS_START + 2 * 60_000,
  },
  {
    id: 'sq_login_1',
    workspaceId: STORY_WORKSPACE_ID,
    executionId: 'exec_login',
    agentKind: 'architect',
    provider: 'searxng',
    query: 'OAuth 2.0 security best current practice refresh tokens',
    resultCount: 1,
    createdAt: CALLS_START - 3 * 60_000,
  },
]
