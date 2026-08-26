import type {
  AgentRunContext,
  ModelRef,
  RunnerDispatchKind,
  RunnerJobRef,
  RunnerTransport,
} from '@cat-factory/kernel'
import type { AgentRouting } from '@cat-factory/agents'
import {
  CONTAINER_DISPATCH_DIRECTIVES,
  EFFORT_REPORT_FILE,
  EFFORT_REPORT_GUIDANCE,
  EXECUTION_SANDBOX_GUIDANCE,
  FINAL_ANSWER_IN_REPLY,
  PR_DESCRIPTION_GUIDANCE,
  READ_ONLY_GUARDRAIL,
  TOOL_PREFERENCE_GUIDANCE,
} from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import {
  ContainerAgentExecutor,
  type ContainerAgentExecutorDependencies,
} from '../src/agents/ContainerAgentExecutor.js'
import type { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// The DIRECTIVES a dispatch appends around a kind's own prompt: the read-only guardrail, the two
// unconditional `CONTAINER_DISPATCH_DIRECTIVES` (execution sandbox, effort report) and the
// PR-description sentinel a PR-opening coding kind gets on top. Split out of
// `containerAgentJobBody.spec` (which pins the per-kind body SHAPES) when that file hit its size
// budget, the same way `containerAgentMultiRepo.spec` was: these texts are composed from three
// different places and only meet at this chokepoint, so what they assert is the COMPOSITION, not
// any one body's shape.

const routing: AgentRouting = {
  default: { ref: { provider: 'workers-ai', model: '@cf/test/model' } as ModelRef },
  byKind: {},
}

interface Captured {
  ref: RunnerJobRef
  spec: Record<string, unknown>
  kind: RunnerDispatchKind | undefined
}

function makeExecutor(): { executor: ContainerAgentExecutor; captured: Captured[] } {
  const captured: Captured[] = []
  const transport: RunnerTransport = {
    async dispatch(ref, spec, kind) {
      captured.push({ ref, spec, kind })
    },
    async poll() {
      return { state: 'running' }
    },
  }
  const deps: ContainerAgentExecutorDependencies = {
    resolveTransport: async () => transport,
    agentRouting: routing,
    resolveBlockModel: () => undefined,
    resolveRepoTarget: async () => ({
      installationId: 7,
      repoId: '1001',
      owner: 'acme',
      name: 'widgets',
      baseBranch: 'main',
    }),
    mintInstallationToken: async () => 'GH-TOKEN',
    sessionService: {
      async mint() {
        return 'SESSION-TOKEN'
      },
    } as unknown as ContainerSessionService,
    proxyBaseUrl: 'https://proxy.test/v1',
    githubApiBase: 'https://api.github.com',
    resolveWebSearchAvailability: async () => ({ available: true, provider: 'searxng' as const }),
    // Read-only agents only probe the work branch; return true so the read-only body
    // resolves to the shared work branch (the more interesting path).
    ensureWorkBranch: async () => true,
  }
  return { executor: new ContainerAgentExecutor(deps), captured }
}

function context(
  agentKind: string,
  overrides: Partial<AgentRunContext['block']> = {},
): AgentRunContext {
  return {
    agentKind: agentKind as AgentRunContext['agentKind'],
    pipelineName: 'Standard build',
    workspaceId: 'ws_1',
    executionId: 'ex_1',
    stepIndex: 0,
    isFinalStep: false,
    block: {
      id: 'blk_1',
      title: 'Add widget',
      type: 'service',
      description: 'Implement the widget feature.',
      ...overrides,
    },
    resolvedDecision: null,
    priorOutputs: [],
    decisions: [],
  }
}

/** The system prompt a single dispatch of `kind` composed. */
async function promptFor(
  kind: string,
  overrides: Partial<AgentRunContext['block']> = {},
): Promise<string> {
  const { executor, captured } = makeExecutor()
  await executor.startJob(context(kind, overrides))
  return captured[0]!.spec.systemPrompt as string
}

const PR = { url: 'https://github.com/acme/widgets/pull/9', number: 9, branch: 'cat-factory/blk_1' }

describe('ContainerAgentExecutor dispatch directives', () => {
  // The two directives below are only ever composed TOGETHER here, at the container-dispatch
  // chokepoint: the guardrail rides `systemPromptFor` and the effort report is appended by
  // `buildKindBody`, so neither package can assert the pair on its own.
  it('reconciles the read-only guardrail with the effort report it is handed', async () => {
    const systemPrompt = await promptFor('architect')
    expect(systemPrompt).toContain(READ_ONLY_GUARDRAIL)
    expect(systemPrompt).toContain(EFFORT_REPORT_GUIDANCE)
    // One instruction forbids creating files and the other orders one written, so the CARVE-OUT
    // rides the effort report: it is the half that reaches every kind the other half can
    // contradict. Without it an agent either disobeyed one of them or spent a turn asking which
    // won, on every read-only run.
    expect(EFFORT_REPORT_GUIDANCE).toContain(EFFORT_REPORT_FILE)
    expect(EFFORT_REPORT_GUIDANCE).toMatch(/forbid you to create, modify or commit/)
    // And the effort report no longer times itself off a commit the agent may not make.
    expect(EFFORT_REPORT_GUIDANCE).not.toContain('after any commit/push')
    // The guardrail claims nothing about the sentinel, so it needs no position relative to the
    // report and stays true on the inline surfaces that also receive it.
    expect(READ_ONLY_GUARDRAIL).not.toContain(EFFORT_REPORT_FILE)
    expect(READ_ONLY_GUARDRAIL).not.toMatch(/instructions below/)
  })

  // The effort write is ordered BEFORE the final reply, never "at the end". A trailing effort
  // write forces one more closing turn after its tool result, and every harness keeps only the
  // very last message, so a kind whose deliverable IS its reply lost an entire architect design
  // to the one-line afterthought that followed, three rework rounds in a row. Only this spec can
  // pin it: the ordering exists to protect FINAL_ANSWER_IN_REPLY kinds, and the two texts meet
  // nowhere but this chokepoint.
  it('orders the effort write before the final reply, never after it', () => {
    expect(EFFORT_REPORT_GUIDANCE).toContain('BEFORE you compose your final reply')
    expect(EFFORT_REPORT_GUIDANCE).toContain('no tool call after the reply')
    expect(EFFORT_REPORT_GUIDANCE).not.toContain('as the last thing you do')
    expect(EFFORT_REPORT_GUIDANCE).not.toContain('at the end')
  })

  // The ordering rule reaches EVERY container kind, so its rationale may only state what the
  // platform keeps, never what the reply is FOR. The side-effect coding kinds are handed this
  // text and deliberately NOT handed `FINAL_ANSWER_IN_REPLY` (their product is a pushed commit
  // and they legitimately end with no answer), so a rationale phrased as "your last message is
  // your answer" would tell them precisely what that fragment's own contract forbids.
  it('states the ordering rule without calling the reply a side-effect deliverable', async () => {
    for (const kind of ['coder', 'ci-fixer', 'conflict-resolver', 'mocker']) {
      const systemPrompt = await promptFor(kind, { pullRequest: PR })
      expect(systemPrompt).toContain(EFFORT_REPORT_GUIDANCE)
      expect(systemPrompt).not.toContain(FINAL_ANSWER_IN_REPLY)
    }
    expect(EFFORT_REPORT_GUIDANCE).toContain('The platform keeps only your very last message')
    expect(EFFORT_REPORT_GUIDANCE).not.toMatch(/is read as your answer|your deliverable is/i)
  })

  // The reviewer-briefing (PR description) sentinel rides ONLY a dispatch that opens a PR: the
  // coder gets it; an in-place fixer (which amends a PR whose description it doesn't own) does
  // not. And on the coder, the chokepoint appends it AFTER the effort report, so whatever THAT
  // text says about timing is the last ordering statement in the prompt: its old "write it once,
  // at the end of your work" reinstated the trailing write on the one path that asks for both
  // sentinels at once.
  it('asks a PR-opening coder for the reviewer briefing, on the same ordering as the effort file', async () => {
    const systemPrompt = await promptFor('coder')
    expect(systemPrompt).toContain(EFFORT_REPORT_GUIDANCE)
    expect(systemPrompt).toContain(PR_DESCRIPTION_GUIDANCE)
    expect(systemPrompt.indexOf(PR_DESCRIPTION_GUIDANCE)).toBeGreaterThan(
      systemPrompt.indexOf(EFFORT_REPORT_GUIDANCE),
    )
    expect(PR_DESCRIPTION_GUIDANCE).toContain('BEFORE you compose your final reply')
    expect(PR_DESCRIPTION_GUIDANCE).not.toContain('at the end of your work')
  })

  it('does not ask an in-place fixer for the reviewer briefing', async () => {
    expect(await promptFor('fixer', { pullRequest: PR })).not.toContain('PULL REQUEST DESCRIPTION')
  })

  // The kinds whose write prohibition is written into a BESPOKE prompt rather than appended by
  // `applySurfaceDirectives`. `composedSystemPromptFor` short-circuits for them, so a carve-out
  // scoped off the surface never reaches them — which is why it lives on the effort report, the
  // one text this chokepoint hands to every container kind whatever its prompt came from.
  it('reconciles the pair for a bespoke container kind too, not only a surface-directed one', async () => {
    for (const kind of ['on-call', 'merger']) {
      const systemPrompt = await promptFor(kind)
      expect(systemPrompt).toContain(EFFORT_REPORT_GUIDANCE)
      // `on-call` is the case that bites: its own directives forbid every write, and nothing in
      // its composition path can see the effort report it is about to be handed.
      expect(systemPrompt).toMatch(/forbid you to create, modify or commit/)
    }
    // `on-call` is the case that bites: its own directives forbid every write, so without the
    // carve-out riding the effort report it is handed an unsatisfiable pair on every dispatch.
    expect(await promptFor('on-call')).toContain('MUST NOT modify, commit or revert anything')
  })

  it('states the execution sandbox contract to every container kind, not just one', async () => {
    // Platform facts no agent can derive from the checkout (no cluster or registry credentials,
    // toolchain versions that are the environment's), plus the rule that an artifact this
    // environment cannot execute is not incomplete for that reason. Absent, a coder and its
    // reviewer each rediscovered that the Dockerfile they were asked for could not be built here.
    for (const kind of ['coder', 'architect', 'reviewer', 'tester-api', 'merger']) {
      expect(await promptFor(kind)).toContain(EXECUTION_SANDBOX_GUIDANCE)
    }
    // `reviewer` is in that list, which is what bounds how far the rule may go: unverifiable is
    // not the same as correct, so the paragraph may not call the artifact correct nor tell the
    // reviewer to withhold a defect it can actually see. Only the LIMIT is not a finding.
    expect(EXECUTION_SANDBOX_GUIDANCE).not.toMatch(/complete and correct deliverable/)
    expect(EXECUTION_SANDBOX_GUIDANCE).toMatch(/not raise the limit itself as a finding/)
    expect(EXECUTION_SANDBOX_GUIDANCE).toMatch(/a defect you can actually see in the artifact/)
    // And it describes the environment without naming one: the same body serves the harness image
    // and, under `LOCAL_NATIVE_AGENTS`, the developer's own machine as a host process, where
    // "an ephemeral Linux container" and "there is no Kubernetes tooling" are both false.
    expect(EXECUTION_SANDBOX_GUIDANCE).toMatch(/a disposable working environment/)
  })

  it('says nothing about what the environment CONTAINS, in either direction', () => {
    // The property, not the absence of the old phrasing (per the note this file gained in #2062).
    // The dispatch cannot know the image's contents: it is composed before a transport is chosen,
    // and the same body reaches a deployment's own image variant and the developer's laptop under
    // `LOCAL_NATIVE_AGENTS`. So the paragraph may neither name a tool as present nor send the
    // agent to look for one, which is what the harness's probed inventory now answers instead.
    // A word here is only a violation as a claim ABOUT THE MACHINE, which is why each is anchored.
    expect(EXECUTION_SANDBOX_GUIDANCE).not.toMatch(/\bdocker\b/i)
    expect(EXECUTION_SANDBOX_GUIDANCE).not.toMatch(/\bkubectl\b/i)
    expect(EXECUTION_SANDBOX_GUIDANCE).not.toMatch(/\bNode toolchain\b/i)
    expect(EXECUTION_SANDBOX_GUIDANCE).not.toMatch(/probe/i)
    // And it does not promise the inventory either. An image older than the backend appends none,
    // so a sentence pointing at one would be the platform asserting what the dispatch may not have
    // delivered: exactly the defect class dropping the probe instruction is on the other side of.
    expect(EXECUTION_SANDBOX_GUIDANCE).not.toMatch(/inventory/i)
    // What survives is the DISPOSITION, which is policy and holds whatever the machine contains.
    expect(EXECUTION_SANDBOX_GUIDANCE).toMatch(/not a defect in the work/)
    expect(EXECUTION_SANDBOX_GUIDANCE).toMatch(/no cluster or container-registry credentials/)
  })

  it('names a tool preference once, to every container kind', async () => {
    // The models stopped reaching for their file tools on their own (four runs of one task in a
    // three-day window used the write tool zero times, against 26 to 34 per dispatch a fortnight
    // earlier) and rewrote whole files through shell heredocs instead. One line, at the chokepoint
    // rather than per track prompt, so every container kind gets the same advice exactly once.
    for (const kind of ['coder', 'architect', 'reviewer', 'merger']) {
      const prompt = await promptFor(kind)
      expect(prompt).toContain(TOOL_PREFERENCE_GUIDANCE)
      expect(prompt.split(TOOL_PREFERENCE_GUIDANCE).length - 1).toBe(1)
    }
    // A NUDGE, deliberately not a rule: which tool a model picks moves under us with no diff on
    // our side, so the text may not be worded as something the platform can rely on, and nothing
    // whose correctness depends on the answer may be built on it.
    expect(TOOL_PREFERENCE_GUIDANCE).not.toMatch(/\b(never|must|always) use\b/i)
    expect(TOOL_PREFERENCE_GUIDANCE).toMatch(/use your file tools/i)
  })

  it('keeps the effort report LAST of the unconditional directives', () => {
    // Its closing sentences are the prompt's ordering statement (the sentinel file before the
    // final reply, and no tool call after it). A directive appended after it would be the last
    // thing the agent reads about ordering, which is the displacement that cost an architect run
    // its 18k-character design.
    expect(CONTAINER_DISPATCH_DIRECTIVES.at(-1)).toBe(EFFORT_REPORT_GUIDANCE)
  })
})
