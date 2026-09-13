import type {
  AgentJobHandle,
  AgentJobUpdate,
  AgentRunContext,
  AgentRunResult,
  RunReclaimReport,
  DelegatedExecutor,
  DelegatedExecutorDefinition,
  DelegationBrief,
  DelegationHandle,
  DelegationUpdate,
  ToolSecretResolver,
} from '@cat-factory/kernel'
import { defaultDelegatedExecutorRegistry, DomainError, noopLogger } from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import { buildDelegatedAgentExecutor } from '../src/agents/delegatedExecutorHost.js'

// What the DELEGATED arm does with an executor's answers: how it routes, what it refuses, and what
// it maps back into the engine's vocabulary. Every assertion below is a place where being wrong is
// invisible on the board: a step that can never be polled, a failure re-driven forever, a zero
// where the platform simply has no number.

const REPO = {
  installationId: 7,
  repoId: '1001',
  owner: 'acme',
  name: 'widgets',
  baseBranch: 'main',
}

interface Fake {
  starts: DelegationBrief[]
  credentials: Record<string, string>[]
  cancels: DelegationHandle[]
  executor: DelegatedExecutor
}

function fakeExecutor(behaviour: Partial<DelegatedExecutor> = {}): Fake {
  const starts: DelegationBrief[] = []
  const credentials: Record<string, string>[] = []
  const cancels: DelegationHandle[] = []
  return {
    starts,
    credentials,
    cancels,
    executor: {
      async start(brief, creds) {
        starts.push(brief)
        credentials.push(creds)
        return { externalId: 'run-99', url: 'https://ci.acme/99' }
      },
      async poll(_handle, creds) {
        credentials.push(creds)
        return { state: 'running' }
      },
      ...behaviour,
      ...(behaviour.cancel
        ? {
            cancel: async (handle, creds) => {
              cancels.push(handle)
              return behaviour.cancel!(handle, creds)
            },
          }
        : {}),
    },
  }
}

function build(
  fake: Fake,
  options: {
    credentials?: DelegatedExecutorDefinition['credentials']
    resolveToolSecrets?: ToolSecretResolver
  } = {},
) {
  const agentKindRegistry = defaultAgentKindRegistry()
  agentKindRegistry.register({
    kind: 'acme:impl',
    systemPrompt: 'implement it',
    agent: { surface: 'delegated', executor: 'acme:executor' },
  })
  const executors = defaultDelegatedExecutorRegistry()
  executors.register({
    id: 'acme:executor',
    presentation: { label: 'Acme', icon: 'i-lucide-bot', description: 'Acme runs it' },
    poll: { intervalMs: 1000, maxDurationMs: 60_000 },
    telemetry: 'not-reported',
    ...(options.credentials ? { credentials: options.credentials } : {}),
    create: () => fake.executor,
  })
  return buildDelegatedAgentExecutor({
    delegatedExecutorRegistry: executors,
    agentKindRegistry,
    resolveRepoTarget: async () => REPO,
    ...(options.resolveToolSecrets ? { resolveToolSecrets: options.resolveToolSecrets } : {}),
    logger: noopLogger,
    clock: { now: () => 0 },
  })
}

function context(): AgentRunContext {
  return {
    agentKind: 'acme:impl',
    pipelineName: 'Standard build',
    workspaceId: 'ws_1',
    executionId: 'ex_1',
    stepIndex: 0,
    isFinalStep: false,
    block: { id: 'blk_1', title: 'Add widget', type: 'service', description: 'Do it.' },
    resolvedDecision: null,
    priorOutputs: [],
    decisions: [],
  }
}

/** The result of a settled poll, narrowed so an assertion can read its fields. */
function doneResult(update: AgentJobUpdate): AgentRunResult {
  if (update.state !== 'done') throw new Error(`expected a settled poll, got ${update.state}`)
  return update.result
}

/** The one delegation a reclaim report names, narrowed past the port's `void` alternative. */
function firstDelegation(
  report: RunReclaimReport | void,
): NonNullable<RunReclaimReport['delegations']>[number] | undefined {
  return report ? report.delegations?.[0] : undefined
}

function handle(): AgentJobHandle {
  return {
    jobId: 'ex_1-acme:impl',
    runId: 'ex_1',
    workspaceId: 'ws_1',
    agentKind: 'acme:impl',
    delegated: { executor: 'acme:executor', externalId: 'run-99' },
  }
}

describe('DelegatedAgentExecutor: dispatch', () => {
  it('returns a handle carrying the executor and its external id', async () => {
    // Everything the poll can route on: it rebuilds this from the STEP, in another process.
    const fake = fakeExecutor()
    const result = await build(fake).startJob(context())
    expect(result.delegated).toEqual({
      executor: 'acme:executor',
      externalId: 'run-99',
      url: 'https://ci.acme/99',
      // The branch pair rides along because a POLL cannot derive it: a handle carries the run, and
      // the work branch is named from the block.
      branches: { base: 'main', work: 'cat-factory/blk_1' },
    })
    expect(result.jobId).toBe('ex_1-acme:impl')
  })

  it('REFUSES a start that named nothing to poll', async () => {
    // Recorded, the step would park on a job nothing can settle and fail hours later on its poll
    // budget, naming a timeout instead of the contract the executor broke.
    const fake = fakeExecutor({ start: async () => ({ externalId: '' }) })
    await expect(build(fake).startJob(context())).rejects.toMatchObject({
      details: { reason: 'delegated_executor_failed' },
    })
  })

  it('reports an executor that refused the dispatch as ITS failure, not a container one', async () => {
    const fake = fakeExecutor({
      start: async () => {
        throw new Error('workflow_dispatch returned 403')
      },
    })
    const error = await build(fake)
      .startJob(context())
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).details?.reason).toBe('delegated_executor_failed')
    expect((error as DomainError).message).toContain('workflow_dispatch returned 403')
  })

  it('resolves no model, so the board never names one that ran nowhere', async () => {
    expect(await build(fakeExecutor()).resolveModel(context())).toBeUndefined()
  })
})

describe('DelegatedAgentExecutor: credentials', () => {
  it('hands the executor its declared credentials under the name it reads', async () => {
    const fake = fakeExecutor()
    const executor = build(fake, {
      credentials: [{ key: 'ACME_TOKEN', envName: 'ACME_API_TOKEN' }],
      resolveToolSecrets: { resolve: async () => ({ ACME_TOKEN: 'secret' }) },
    })
    await executor.startJob(context())
    expect(fake.credentials[0]).toEqual({ ACME_API_TOKEN: 'secret' })
  })

  it('never puts a credential in the brief', async () => {
    const fake = fakeExecutor()
    await build(fake, {
      credentials: [{ key: 'ACME_TOKEN' }],
      resolveToolSecrets: { resolve: async () => ({ ACME_TOKEN: 'secret' }) },
    }).startJob(context())
    expect(JSON.stringify(fake.starts[0])).not.toContain('secret')
  })

  it('RE-RESOLVES on every poll rather than caching on the handle', async () => {
    // A delegated poll can run hours after the dispatch and a GitHub App token lives one hour, so
    // a credential frozen at dispatch is dead exactly on the long runs this class exists for.
    let issued = 0
    const fake = fakeExecutor()
    const executor = build(fake, {
      credentials: [{ key: 'ACME_TOKEN' }],
      resolveToolSecrets: { resolve: async () => ({ ACME_TOKEN: `token-${++issued}` }) },
    })
    await executor.startJob(context())
    await executor.pollJob(handle())
    expect(fake.credentials).toEqual([{ ACME_TOKEN: 'token-1' }, { ACME_TOKEN: 'token-2' }])
  })

  it('withholds a reserved platform key rather than handing it over', async () => {
    // The lookup key is a boundary: a resolver reads it off the deployment's own environment, so
    // an executor declaring `ENCRYPTION_KEY` would hand the master sealing key to whatever it posts to.
    const fake = fakeExecutor()
    await build(fake, {
      credentials: [{ key: 'ENCRYPTION_KEY' }],
      resolveToolSecrets: { resolve: async () => ({ ENCRYPTION_KEY: 'master' }) },
    }).startJob(context())
    expect(fake.credentials[0]).toEqual({})
  })
})

describe('DelegatedAgentExecutor: poll mapping', () => {
  const poll = (update: DelegationUpdate) =>
    build(fakeExecutor({ poll: async () => update })).pollJob(handle())

  it('carries a late-arriving external URL onto the record', async () => {
    // Many systems cannot supply one until the run has an id, and the link is the primary
    // affordance on a delegated step.
    expect(
      await poll({ state: 'running', url: 'https://ci.acme/99', phase: 'building' }),
    ).toMatchObject({
      state: 'running',
      phase: 'building',
      delegated: { url: 'https://ci.acme/99' },
    })
  })

  it('treats a failure the executor did not call retryable as TERMINAL', async () => {
    // A verdict its own system called final is not something a second dispatch improves on, and
    // the alternative spends the job-failure budget re-running somebody else's CI for it.
    const update = await poll({ state: 'failed', error: 'the workflow failed' })
    expect(update).toMatchObject({ state: 'failed', harnessShutdown: true })
  })

  it('leaves a RETRYABLE failure re-drivable', async () => {
    const update = await poll({ state: 'failed', error: 'runner outage', retryable: true })
    expect(update).toMatchObject({ state: 'failed' })
    expect(update).not.toHaveProperty('harnessShutdown')
  })

  it('records the summary and the pull request, and NO usage when none was reported', async () => {
    // Absent is the honest state; a zero would be summed into the run's total and read as work
    // that cost nothing.
    const update = await poll({
      state: 'done',
      result: {
        summary: 'Implemented the widget.',
        pullRequest: { url: 'https://github.com/acme/widgets/pull/9', number: 9, branch: 'b' },
      },
    })
    expect(update).toMatchObject({
      state: 'done',
      result: { output: 'Implemented the widget.', pullRequest: { number: 9 } },
    })
    expect(doneResult(update)).not.toHaveProperty('usage')
  })

  it('passes usage straight through when the executor DOES report it', async () => {
    const update = await poll({
      state: 'done',
      result: { summary: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
    })
    expect(update).toMatchObject({ result: { usage: { inputTokens: 10, outputTokens: 5 } } })
  })

  it('refuses a poll whose handle carries no delegation to address', async () => {
    await expect(build(fakeExecutor()).pollJob({ jobId: 'x' })).rejects.toBeInstanceOf(DomainError)
  })
})

describe('DelegatedAgentExecutor: reclaim', () => {
  const target = {
    runId: 'ex_1',
    workspaceId: 'ws_1',
    jobId: 'ex_1-acme:impl',
    agentKinds: ['acme:impl'],
    delegations: [
      {
        executor: 'acme:executor',
        correlationKey: 'ex_1-acme:impl',
        externalId: 'run-99',
        workspaceId: 'ws_1',
        runId: 'ex_1',
        agentKind: 'acme:impl',
      },
    ],
  }

  it('cancels and REPORTS that it cancelled', async () => {
    const fake = fakeExecutor({ cancel: async () => {} })
    expect(await build(fake).reclaimRun(target)).toEqual({
      delegations: [{ correlationKey: 'ex_1-acme:impl', cancelled: true }],
    })
    expect(fake.cancels).toHaveLength(1)
  })

  it('SAYS the work was left running when the executor declares no cancel', async () => {
    // The external run will finish, open its pull request and bill its tokens long after the
    // platform recorded this run as stopped, and the person who stopped it needs to know.
    const entry = firstDelegation(await build(fakeExecutor()).reclaimRun(target))
    expect(entry).toMatchObject({ correlationKey: 'ex_1-acme:impl', cancelled: false })
    expect(entry?.note).toContain('declares no cancel')
  })

  it('reports a FAILED cancel as not cancelled rather than swallowing it', async () => {
    const fake = fakeExecutor({
      cancel: async () => {
        throw new Error('403 from the runner')
      },
    })
    const entry = firstDelegation(await build(fake).reclaimRun(target))
    expect(entry).toMatchObject({ cancelled: false })
    expect(entry?.note).toContain('403 from the runner')
  })

  it('does nothing for a run that holds no external work', async () => {
    expect(await build(fakeExecutor()).reclaimRun({ ...target, delegations: [] })).toBeUndefined()
  })
})
