import type {
  ModelProvider,
  ModelRef,
  MonorepoAdoptionExplorer,
  MonorepoAdoptionSubject,
  MonorepoExplorationRequest,
  RecordAgentContextInput,
} from '@cat-factory/kernel'
import { readInlineObservabilityContext } from '@cat-factory/kernel'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { MonorepoAdoptionAdvisorService } from './MonorepoAdoptionAdvisorService.js'

// The WIRING test for the survey's tool loop: it asserts the advisor actually attaches the
// exploration tools to its `generateText` call, runs the model's tool calls against the
// explorer, and ends on an answer rather than on a tool call.
//
// The conformance group drives the flow with a fake ADVISOR, so nothing there exercises
// `generateText` at all: the stop condition, the tools and the final-step withdrawal are exactly
// the parts a fake advisor structurally cannot cover, and each of them fails silently (a plan
// that cites nothing, or thirty paid round trips reported as an unusable analysis).

/** The options one `doGenerate` was handed, so a test can assert what the loop sent. */
type GenerateOptions = Record<string, unknown>

/**
 * A provider whose model replies with a scripted sequence of steps, recording what each was
 * asked. A step is either a tool call or the final text.
 */
function scriptedProvider(steps: ({ tool: string; path: string } | { text: string })[]): {
  provider: ModelProvider
  seen: GenerateOptions[]
} {
  const seen: GenerateOptions[] = []
  const provider: ModelProvider = {
    resolve(_ref: ModelRef): ReturnType<ModelProvider['resolve']> {
      return new MockLanguageModelV3({
        doGenerate: async (options) => {
          const step = steps[seen.length] ?? { text: '{"decisions":[]}' }
          seen.push(options as unknown as GenerateOptions)
          const content =
            'tool' in step
              ? [
                  {
                    type: 'tool-call' as const,
                    toolCallId: `call-${seen.length}`,
                    toolName: step.tool,
                    input: JSON.stringify({ path: step.path }),
                  },
                ]
              : [{ type: 'text' as const, text: step.text }]
          return {
            content,
            finishReason: {
              unified: 'tool' in step ? ('tool-calls' as const) : ('stop' as const),
              raw: 'stop',
            },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          }
        },
      }) as unknown as ReturnType<ModelProvider['resolve']>
    },
  }
  return { provider, seen }
}

/** An explorer over a fixed map, recording every request the loop routed to it. */
function fakeExplorer(files: Record<string, string>): {
  explorer: MonorepoAdoptionExplorer
  calls: MonorepoExplorationRequest[]
} {
  const calls: MonorepoExplorationRequest[] = []
  return {
    calls,
    explorer: {
      sides: ['monorepo', 'template'],
      async explore(request) {
        calls.push(request)
        const body = files[request.path]
        return body === undefined
          ? { outcome: 'absent', body: '', note: 'no such file', key: null }
          : { outcome: 'read', body, note: null, key: `${request.side}:${request.path}` }
      },
    },
  }
}

const SUBJECT_BASE = {
  workspaceId: 'ws_1',
  runId: 'boot_1',
  directory: 'services/payments',
  instructions: 'A payments service.',
  survey: {
    reads: [
      {
        path: 'monorepo:package.json',
        origin: 'seed' as const,
        outcome: 'read' as const,
        chars: 2,
        note: null,
      },
    ],
    siblingServices: ['services/billing'],
    exploration: {
      calls: 0,
      maxCalls: 24,
      chars: 0,
      maxChars: 54_000,
      exhausted: null,
      recordsDropped: 0,
    },
  },
  files: { 'monorepo:package.json': '{}' },
}

function subjectWith(explorer: MonorepoAdoptionExplorer): MonorepoAdoptionSubject {
  return { ...SUBJECT_BASE, explorer }
}

function advisorFor(
  provider: ModelProvider,
  agentContextObservability?: { record: (input: RecordAgentContextInput) => Promise<void> },
): MonorepoAdoptionAdvisorService {
  return new MonorepoAdoptionAdvisorService({
    modelProvider: provider,
    modelRef: { provider: 'mock', model: 'm1' },
    ...(agentContextObservability ? { agentContextObservability } : {}),
  })
}

const PLAN = JSON.stringify({
  decisions: [
    {
      id: 'test-runner',
      area: 'testing',
      title: 'Test runner',
      recommended: 'monorepo',
      rationale: 'One runner.',
      evidence: ['monorepo:services/billing/package.json'],
    },
  ],
})

describe('MonorepoAdoptionAdvisorService', () => {
  it('attaches the exploration tools, one pair per side the explorer can reach', async () => {
    const { provider, seen } = scriptedProvider([{ text: PLAN }])
    const { explorer } = fakeExplorer({})
    await advisorFor(provider).advise(subjectWith(explorer))
    const tools = (seen[0]?.tools ?? []) as { name: string }[]
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'list_monorepo_directory',
      'list_template_directory',
      'read_monorepo_file',
      'read_template_file',
    ])
  })

  it('runs the model’s reads against the explorer and answers on a later step', async () => {
    // The loop is the whole change: a one-shot call would return the tool call itself and the
    // plan would cite a file nobody fetched.
    const { provider, seen } = scriptedProvider([
      { tool: 'read_monorepo_file', path: 'services/billing/package.json' },
      { text: PLAN },
    ])
    const { explorer, calls } = fakeExplorer({
      'services/billing/package.json': '{"name":"@acme/billing"}',
    })
    const { plan } = await advisorFor(provider).advise(subjectWith(explorer))
    expect(calls).toEqual([
      { side: 'monorepo', kind: 'read', path: 'services/billing/package.json' },
    ])
    expect(seen).toHaveLength(2)
    expect(plan).toMatchObject({ decisions: [{ id: 'test-runner' }] })
  })

  it('withdraws the tools for the last step, so a loop that keeps calling still answers', async () => {
    // Without it a loop stopped by the step cap ends ON a tool call, `result.text` is empty, and
    // the survey reports `analysis_unusable` after paying for every one of those round trips.
    const { provider, seen } = scriptedProvider(
      Array.from({ length: 40 }, () => ({ tool: 'list_monorepo_directory', path: 'services' })),
    )
    const { explorer } = fakeExplorer({})
    await expect(advisorFor(provider).advise(subjectWith(explorer))).rejects.toThrow(
      /no JSON adoption plan/,
    )
    // The loop is bounded, and the step it stops on was told not to call a tool.
    expect(seen.length).toBeLessThan(40)
    expect(seen.at(-1)?.toolChoice).toEqual({ type: 'none' })
    expect(seen.at(-2)?.toolChoice).not.toEqual({ type: 'none' })
  })

  it('tags every step of the loop with the SAME agent kind, so the calls roll up as one survey', async () => {
    // The loop is several vendor calls where the declared read was one. Tagged per step they
    // would read as N surveys in the per-kind spend rollup instead of one that cost more.
    const { provider, seen } = scriptedProvider([
      { tool: 'read_monorepo_file', path: 'services/billing/package.json' },
      { text: PLAN },
    ])
    const { explorer } = fakeExplorer({ 'services/billing/package.json': '{}' })
    await advisorFor(provider).advise(subjectWith(explorer))
    // Read back through the same helper the instrumentation uses, so the assertion cannot go
    // stale against a namespace rename it would then silently pass.
    const kinds = seen.map((options) => readInlineObservabilityContext(options).agentKind)
    expect(kinds).toEqual(['monorepo-adoption-advisor', 'monorepo-adoption-advisor'])
  })

  it('records what the survey handed its model, under the run and its own step', async () => {
    // The survey is half of what a monorepo bootstrap costs, and its prompt is the half no
    // container dispatch files: without this the run's Provided-context tab holds the apply's
    // snapshot alone, which reads as a survey that was given nothing rather than one whose
    // context was never recorded.
    const snapshots: RecordAgentContextInput[] = []
    const { provider } = scriptedProvider([{ text: PLAN }])
    const { explorer } = fakeExplorer({})
    await advisorFor(provider, {
      record: async (input) => {
        snapshots.push(input)
      },
    }).advise(subjectWith(explorer))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      workspaceId: 'ws_1',
      executionId: 'boot_1',
      agentKind: 'monorepo-adoption-advisor',
      // The survey is a monorepo run's FIRST step, numbered as the board numbers it.
      stepIndex: 0,
      // `provider:model`, the format the snapshot contract documents.
      model: 'mock:m1',
      // An inline call runs under no harness: stated as none rather than named.
      harness: null,
    })
    // The seeded opening context, under the same prefixed keys a decision's evidence cites.
    expect(snapshots[0]?.contextFiles.map((file) => file.path)).toEqual(['monorepo:package.json'])
    expect(snapshots[0]?.systemPrompt).not.toBe('')
    expect(snapshots[0]?.userPrompt).toContain('services/payments')
  })

  it('records the survey context even when the reply comes back unusable', async () => {
    // The run whose prompt someone actually needs to read is the one that produced nothing. A
    // snapshot written after the generation is the one missing exactly then.
    const snapshots: RecordAgentContextInput[] = []
    const { provider } = scriptedProvider([{ text: 'not json at all' }])
    const { explorer } = fakeExplorer({})
    await expect(
      advisorFor(provider, {
        record: async (input) => {
          snapshots.push(input)
        },
      }).advise(subjectWith(explorer)),
    ).rejects.toThrow(/no JSON adoption plan/)
    expect(snapshots).toHaveLength(1)
  })

  it('files every step under the bootstrap RUN, so the survey is readable from the run', async () => {
    // Untagged, the loop's rows are in the telemetry store and outside every run-scoped read,
    // which renders as a survey phase that spent nothing, on the run whose other half (the
    // apply container) reports its spend fine, so the discrepancy reads as a missing phase.
    const { provider, seen } = scriptedProvider([
      { tool: 'read_monorepo_file', path: 'services/billing/package.json' },
      { text: PLAN },
    ])
    const { explorer } = fakeExplorer({ 'services/billing/package.json': '{}' })
    await advisorFor(provider).advise(subjectWith(explorer))
    const runs = seen.map((options) => readInlineObservabilityContext(options).executionId)
    expect(runs).toEqual(['boot_1', 'boot_1'])
  })
})
