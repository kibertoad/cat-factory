import type { Meta, StoryObj } from '@storybook/vue3'
import {
  getExecutionAgentContextContract,
  getExecutionLlmMetricsContract,
  getExecutionSearchQueriesContract,
  getExecutionToolCallFailuresContract,
  getExecutionToolCallsContract,
  REPO_BOOTSTRAP_AGENT_KIND,
  type AgentContextSnapshot,
  type AgentSearchQuery,
  type LlmCallMetric,
  type RunToolCallFailures,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { screen, userEvent } from 'storybook/test'
import type { ExecutionInstance } from '~/types/domain'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { block } from '~/stories/block.stories.mocks'
import { boardBlocks } from '~/stories/board.stories.mocks'
import { BILLING_FRAME_ID, failedApplyJob } from '~/stories/bootstrap.stories.mocks'
import {
  llmCall,
  loginCalls,
  loginContext,
  loginPhases,
  loginSearches,
  loginToolCalls,
  loginToolFailures,
  rateLimitedCall,
  stepMetrics,
} from '~/stories/observability.stories.mocks'
import { failure, step } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useAgentRunsStore } from '~/stores/agentRuns'
import { useUiStore } from '~/stores/ui'
import ObservabilityPanel from './ObservabilityPanel.vue'

// The telemetry of one run, over the whole screen: the model calls with the run's totals and
// where its tokens went by phase, then the tool calls, the context each agent was given and the
// web searches, each in its own tab. When the run or one of its calls failed, a summary of what
// broke is pinned above it all. The panel opens from a step (`ui.openObservability`) and reads
// four of its five sinks at once; the tool calls tab reads the fifth on its first open. The run is
// the login task's, and its telemetry is the shared one (`observability.stories.mocks.ts`).
// Export JSON downloads a file no story answers.

/** The login run, on the build pipeline, with the phase rollup and search on its steps. */
function loginRun(overrides: Partial<ExecutionInstance> = {}): ExecutionInstance {
  const search = { available: true, provider: 'searxng' as const }
  return execution({
    steps: [
      step({
        agentKind: 'architect',
        state: 'done',
        progress: 1,
        search,
        metrics: stepMetrics({ calls: 1, byPhase: [loginPhases[2]!] }),
      }),
      step({
        agentKind: 'coder',
        state: 'working',
        progress: 0.6,
        search,
        metrics: stepMetrics({ calls: 4, byPhase: loginPhases.slice(0, 2) }),
      }),
      step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
    ],
    ...overrides,
  })
}

/** What each sink answers. A handler in place of a body is used as it is. */
interface Sinks {
  calls?: LlmCallMetric[] | HttpHandler
  context?: AgentContextSnapshot[]
  searches?: AgentSearchQuery[]
  failures?: RunToolCallFailures
  toolCalls?: typeof loginToolCalls
}

/** The six coder calls that succeeded, read as a run whose tools never failed. */
const noToolFailures: RunToolCallFailures = {
  total: loginToolCalls.filter((c) => c.ok).length,
  failed: 0,
  failures: [],
  failuresTruncated: false,
}

function sinks(executionId: string, s: Sinks): HttpHandler[] {
  const at = { pathPrefix: storyWorkspacePrefix, pathParams: { executionId } }
  const calls = s.calls ?? loginCalls
  const toolCalls = s.toolCalls ?? loginToolCalls.filter((c) => c.ok)
  return [
    Array.isArray(calls)
      ? apiResponse(getExecutionLlmMetricsContract, { ...at, body: { executionId, calls } })
      : calls,
    apiResponse(getExecutionAgentContextContract, {
      ...at,
      body: { executionId, snapshots: s.context ?? loginContext },
    }),
    apiResponse(getExecutionSearchQueriesContract, {
      ...at,
      body: { executionId, searchQueries: s.searches ?? loginSearches },
    }),
    apiResponse(getExecutionToolCallFailuresContract, {
      ...at,
      body: { executionId, ...(s.failures ?? noToolFailures) },
    }),
    apiResponse(getExecutionToolCallsContract, {
      ...at,
      body: { executionId, toolCalls, truncated: false },
    }),
  ]
}

/** The panel opened over `run`, whose sinks answer `s`. */
function panel(run: ExecutionInstance, s: Sinks = {}): Story {
  return {
    decorators: [
      withSeed(() => {
        seedSnapshot(snapshot({ executions: [run] }))
        useUiStore().openObservability(run.id)
      }),
    ],
    parameters: { api: sinks(run.id, s) },
  }
}

/** Open the tab named `name`, then wait for `shown`, a text that only that tab draws. */
function tab(name: string, shown?: string) {
  return async () => {
    await userEvent.click(await screen.findByRole('tab', { name }))
    await screen.findByRole('tab', { name, selected: true })
    if (shown) await screen.findByText(shown)
  }
}

const meta = {
  title: 'Run telemetry/Pages/ObservabilityPanel',
  component: ObservabilityPanel,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ObservabilityPanel>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The coder is at work: the run's totals with the cache split and one reply cut short, the three
 * phases by carry cost with their cost in euros, and the five calls, newest first.
 */
export const Default: Story = panel(loginRun())

const loginAt = {
  pathPrefix: storyWorkspacePrefix,
  pathParams: { executionId: 'exec_login' },
}

/** The call list is still on its way: placeholder rows under the totals. */
export const Loading: Story = panel(loginRun(), {
  calls: apiPending(getExecutionLlmMetricsContract, loginAt),
})

/**
 * The call list could not be read: its error and Retry, and the pinned summary says that nothing
 * can be concluded about the calls.
 */
export const Error: Story = panel(loginRun(), {
  calls: apiFailure(getExecutionLlmMetricsContract, loginAt),
})

/** The run has not called a model yet, and no sink holds a row. */
export const Empty: Story = panel(
  loginRun({
    steps: [
      step({ agentKind: 'architect', state: 'working', progress: 0.1 }),
      step({ agentKind: 'coder', state: 'pending', progress: 0 }),
      step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
    ],
    currentStep: 0,
  }),
  {
    calls: [],
    context: [],
    searches: [],
    failures: { total: 0, failed: 0, failures: [], failuresTruncated: false },
    toolCalls: [],
  },
)

const runningLogin = loginRun()
const failedRun = loginRun({
  status: 'failed',
  failure: failure({
    message: 'The coder stopped after the model provider refused a call.',
    stepIndex: 1,
  }),
  steps: runningLogin.steps.map((s) =>
    s.agentKind === 'coder'
      ? {
          ...s,
          metrics: stepMetrics({
            calls: 4,
            byPhase: [{ ...loginPhases[0]!, errors: 1 }, loginPhases[1]!],
          }),
        }
      : s,
  ),
})
const failedSinks: Sinks = {
  calls: [rateLimitedCall, ...loginCalls],
  failures: loginToolFailures,
  toolCalls: loginToolCalls,
}

/**
 * The run failed: what broke is pinned above the totals, with the refused call and the failing
 * test run, each with a link to its row.
 */
export const FailedRun: Story = panel(failedRun, failedSinks)

/** The tool calls tab on the failed run: the coder's seven calls, one failed. */
export const ToolCalls: Story = {
  ...panel(failedRun, failedSinks),
  play: tab('Tool calls', 'what the agents did, in the order they did it'),
}

/** The provided context tab, with the coder's opened: its prompts, fragment, file and details. */
export const ProvidedContext: Story = {
  ...panel(loginRun()),
  play: async () => {
    await tab('Provided context')()
    await userEvent.click(await screen.findByRole('button', { name: /Coder/ }))
    await screen.findByText('System prompt')
  },
}

/** The web search tab: search was on, through SearXNG, and the two queries the agents made. */
export const WebSearch: Story = {
  ...panel(loginRun()),
  play: tab('Web search', 'refresh token rotation reuse detection'),
}

const bootstrapRun = failedApplyJob()
const billingFrame = block({
  id: BILLING_FRAME_ID,
  title: 'Billing',
  level: 'frame',
  parentId: null,
})

/**
 * A monorepo bootstrap that failed: it has no execution, so the subtitle names the run kind, the
 * cost tile and the phase table say that there is no rollup to read, and the failure is the
 * bootstrap's own.
 */
export const Bootstrap: Story = {
  decorators: [
    withSeed(() => {
      seedSnapshot(snapshot({ blocks: [...boardBlocks, billingFrame] }))
      useAgentRunsStore().bootstrapJobs = [bootstrapRun]
      useUiStore().openObservability(bootstrapRun.id)
    }),
  ],
  parameters: {
    api: sinks(bootstrapRun.id, {
      calls: [
        llmCall({
          id: 'llm_boot_1',
          executionId: bootstrapRun.id,
          agentKind: REPO_BOOTSTRAP_AGENT_KIND,
          phase: '',
          createdAt: Date.UTC(2026, 9, 11, 10, 30),
          responseText: 'Wrote services/billing/src/invoices.ts.',
        }),
        llmCall({
          id: 'llm_boot_0',
          executionId: bootstrapRun.id,
          agentKind: REPO_BOOTSTRAP_AGENT_KIND,
          phase: '',
          createdAt: Date.UTC(2026, 9, 11, 10, 6),
          responseText: 'The monorepo uses pnpm workspaces and one shared tsconfig.',
        }),
      ],
      context: [],
      searches: [],
      failures: { total: 0, failed: 0, failures: [], failuresTruncated: false },
      toolCalls: [],
    }),
  },
}
