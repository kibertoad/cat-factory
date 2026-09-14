import type {
  AgentJobHandle,
  AgentJobUpdate,
  AgentRunContext,
  AgentRunResult,
  RunReclaimReport,
  DelegatedExecutor,
  DelegatedExecutorDefinition,
  DelegatedExecutorDeps,
  DelegatedFetchResponse,
  DelegationBrief,
  DelegationHandle,
  DelegationUpdate,
  ToolSecretResolver,
} from '@cat-factory/kernel'
import { defaultDelegatedExecutorRegistry, DomainError, noopLogger } from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import { buildDelegatedAgentExecutor } from '../src/agents/delegatedExecutorHost.js'
import { githubRepoOrigin } from '../src/agents/containerAgentBody.js'

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

/** A minimal response for a fetch double: the four members `DelegatedFetchResponse` names. */
function okResponse(): DelegatedFetchResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '',
    json: async () => ({}),
  }
}

/**
 * The GUARDED fetch an executor is actually built over, which is what carries the deadline, the
 * cap and the URL policy. Reached through the host rather than reimplemented, because an executor
 * is deployment-authored code and the whole point of the wrapper is that no author applies it.
 */
async function guardedFetch(
  observe?: (url: string, init?: { signal?: unknown }) => void,
  overrides: Partial<DelegatedFetchResponse> = {},
) {
  const fake = fakeExecutor()
  let seen: DelegatedExecutorDeps | undefined
  await build(fake, {
    onDeps: (deps) => (seen = deps),
    fetchImpl: async (url, init) => {
      observe?.(url, init)
      return { ...okResponse(), ...overrides } as never
    },
  }).startJob(context())
  return seen!.fetchImpl
}

function build(
  fake: Fake,
  options: {
    credentials?: DelegatedExecutorDefinition['credentials']
    resolveToolSecrets?: ToolSecretResolver
    /** Capture the bound deps an executor is built over (the guarded fetch lives on them). */
    onDeps?: (deps: DelegatedExecutorDeps) => void
    /** The runtime fetch the guard wraps; absent ⇒ the host's own default is never called. */
    fetchImpl?: DelegatedExecutorDeps['fetchImpl']
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
    create: (deps) => {
      options.onDeps?.(deps)
      return fake.executor
    },
  })
  return buildDelegatedAgentExecutor({
    delegatedExecutorRegistry: executors,
    agentKindRegistry,
    resolveRepoTarget: async () => REPO,
    resolveRepoOrigin: githubRepoOrigin,
    ...(options.resolveToolSecrets ? { resolveToolSecrets: options.resolveToolSecrets } : {}),
    // Answered explicitly: the host requires an answer so a facade cannot leave the outbound guard
    // declared-but-unwired, which is exactly what both of them had done.
    urlSafetyPolicy: undefined,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
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
    blockId: 'blk_1',
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
      // So does the TARGET repo, which is routinely not the one holding the executor's own job: an
      // executor reading back what it produced from its own configured repository would look in
      // the wrong place on every deployment whose automation lives beside the product repos.
      repo: { owner: 'acme', name: 'widgets' },
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

  it('ENFORCES the deployment’s outbound-URL policy on every executor call', async () => {
    // The SSRF control an executor answers to, the same one the notification-webhook sender is
    // held to. Declared on both sides and read by nobody, it was a guard that existed only in the
    // types; it now lives in the fetch every executor is built over, which is the only version of
    // it a deployment's own executor code cannot forget to apply.
    const reached: string[] = []
    const agentKindRegistry = defaultAgentKindRegistry()
    agentKindRegistry.register({
      kind: 'acme:impl',
      systemPrompt: 'implement it',
      agent: { surface: 'delegated', executor: 'acme:executor' },
    })
    const executors = defaultDelegatedExecutorRegistry()
    let seen: DelegatedExecutorDeps | undefined
    const fake = fakeExecutor()
    executors.register({
      id: 'acme:executor',
      presentation: { label: 'Acme', icon: 'i-lucide-bot', description: 'Acme runs it' },
      poll: { intervalMs: 1000, maxDurationMs: 60_000 },
      telemetry: 'not-reported',
      create: (deps) => {
        seen = deps
        return fake.executor
      },
    })
    const policy = { schemes: ['https', 'http'], allowHosts: ['ci.acme'] }
    await buildDelegatedAgentExecutor({
      delegatedExecutorRegistry: executors,
      agentKindRegistry,
      resolveRepoTarget: async () => REPO,
      resolveRepoOrigin: githubRepoOrigin,
      urlSafetyPolicy: policy,
      logger: noopLogger,
      clock: { now: () => 0 },
      // A fetch that records rather than calls: what matters is WHICH urls reach it.
      fetchImpl: async (url) => {
        reached.push(url)
        return okResponse()
      },
    }).startJob(context())
    // The widened policy admits what the deployment allowed...
    await expect(seen?.fetchImpl('http://ci.acme/jobs')).resolves.toBeDefined()
    expect(reached).toEqual(['http://ci.acme/jobs'])
    // ...and the guard still refuses what it did not, rather than existing only in the types.
    await expect(seen?.fetchImpl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /public host/,
    )
    expect(reached).toEqual(['http://ci.acme/jobs'])
  })

  it('refuses a non-https executor endpoint under the default policy', async () => {
    // The strict default is the notification webhook's, for the same reason: an executor's base
    // URL is operator-supplied, and its calls carry a credential.
    const fake = fakeExecutor()
    let seen: DelegatedExecutorDeps | undefined
    await build(fake, { onDeps: (deps) => (seen = deps) }).startJob(context())
    await expect(seen?.fetchImpl('http://ci.acme/jobs')).rejects.toThrow(/must use https/)
  })

  it('gives every executor call a DEADLINE, and keeps one the caller set', async () => {
    // Without it a hung endpoint holds `pollJob` open indefinitely, which on Node ties up a
    // pg-boss worker: the ordinary shape of an outage in somebody else's system.
    const inits: (AbortSignal | undefined)[] = []
    const guarded = await guardedFetch((_url, init) => {
      inits.push(init?.signal as AbortSignal | undefined)
    })
    await guarded('https://ci.acme/jobs')
    expect(inits[0]).toBeInstanceOf(AbortSignal)
    expect(inits[0]?.aborted).toBe(false)
    const own = new AbortController().signal
    await guarded('https://ci.acme/jobs', { signal: own })
    expect(inits[1]).toBe(own)
  })

  it('CAPS what one response may return, rather than buffering whatever arrives', async () => {
    // The third protection `safe-fetch` exists for, and the one a wrapper that only re-validates
    // redirect hops leaves off: a broken or hostile endpoint answering hundreds of megabytes
    // would otherwise be read whole into the isolate.
    const guarded = await guardedFetch(undefined, {
      headers: { get: (name: string) => (name === 'content-length' ? '999999999' : null) },
    })
    const response = await guarded('https://ci.acme/jobs')
    await expect(response.text()).rejects.toThrow(/too large/i)
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

  it('resolves a poll and a cancel in the SAME scope the dispatch used', async () => {
    // `ToolSecretResolver.resolve` takes the block so a per-service credential store can scope its
    // lookup. Dropped on the poll, such a deployment starts the external run fine and then polls
    // it for the rest of its life with an empty bag: every call fails on a missing credential and
    // the run dies as "status was unreadable" while the external work carries on.
    const scopes: (string | undefined)[] = []
    const fake = fakeExecutor({ cancel: async () => {} })
    const executor = build(fake, {
      credentials: [{ key: 'ACME_TOKEN' }],
      resolveToolSecrets: {
        resolve: async (input): Promise<Record<string, string>> => {
          scopes.push(input.blockId)
          return input.blockId === 'blk_1' ? { ACME_TOKEN: 'secret' } : {}
        },
      },
    })
    await executor.startJob(context())
    await executor.pollJob(handle())
    await executor.reclaimRun({
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
          blockId: 'blk_1',
          runId: 'ex_1',
          agentKind: 'acme:impl',
        },
      ],
    })
    // Three resolves (dispatch, poll, cancel), every one of them scoped to the block.
    expect(scopes).toEqual(['blk_1', 'blk_1', 'blk_1'])
    // And the two calls that receive a bag got a filled one, which is what an out-of-scope
    // lookup would not have produced.
    expect(fake.credentials).toEqual([{ ACME_TOKEN: 'secret' }, { ACME_TOKEN: 'secret' }])
  })

  it('REFUSES a poll whose handle names no block, rather than resolving out of scope', async () => {
    // A handle without it was built somewhere the engine does not build handles. Refusing names
    // that; resolving anyway is a run that dies hours later reporting a timeout.
    const { blockId: _dropped, ...withoutBlock } = handle()
    const error = await build(fakeExecutor())
      .pollJob(withoutBlock as AgentJobHandle)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).details?.reason).toBe('delegated_claim_missing')
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

  it('treats a failure the executor did not call retryable as TERMINAL, on its OWN channel', async () => {
    // A verdict its own system called final is not something a second dispatch improves on, and
    // the alternative spends the job-failure budget re-running somebody else's CI for it.
    //
    // Reported as `delegated.disposition`, never as `harnessShutdown`: the two want the same
    // handling under different names, and borrowing the container flag put "Harness shut down"
    // in front of an operator whose step never had a harness.
    const update = await poll({ state: 'failed', error: 'the workflow failed' })
    expect(update).toMatchObject({ state: 'failed', delegated: { disposition: 'terminal' } })
    expect(update).not.toHaveProperty('harnessShutdown')
  })

  it('STATES a retryable failure as such, rather than leaving it to be inferred', async () => {
    // Both ways round, because the engine branches both ways: `retryable` buys one fresh
    // dispatch, `terminal` fails the run at once. Read as "absent means retryable", the pair was
    // one flag with an unstated default and no re-drive behind it at all.
    const update = await poll({ state: 'failed', error: 'runner outage', retryable: true })
    expect(update).toMatchObject({ state: 'failed', delegated: { disposition: 'retryable' } })
    expect(update).not.toHaveProperty('harnessShutdown')
  })

  it('STAMPS a running poll with a sign of life the executor did not report', async () => {
    // A successful poll is itself the evidence. Without this, a long external run whose every poll
    // answers identically (an Actions run sitting at `in_progress`) folds no change at all, the
    // step's `lastActivityAt` freezes at the first poll, and the stale-run sweeper re-collects a
    // run that is perfectly alive.
    const update = await poll({ state: 'running', phase: 'in_progress' })
    expect(update).toMatchObject({ state: 'running', lastActivityAt: expect.any(Number) })
  })

  it('prefers the executor’s OWN activity stamp when it reports one', async () => {
    const update = await poll({ state: 'running', lastActivityAt: 1_700_000_000_000 })
    expect(update).toMatchObject({ lastActivityAt: 1_700_000_000_000 })
  })

  it('carries the branch the work LANDED on when no pull request was opened', async () => {
    // The port names that case as legitimate (push now, let a later step open the PR), and this is
    // then the run's entire product: dropped, the step settles done with nothing to show.
    const update = await poll({
      state: 'done',
      result: { summary: 'Pushed the work.', branch: 'cat-factory/blk_1' },
    })
    expect(update).toMatchObject({ state: 'done', delegated: { branch: 'cat-factory/blk_1' } })
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

  it('refuses a poll whose handle carries no delegation, NAMING the run state rather than a registration', async () => {
    // Not `delegated_executor_unwired`: that reason's copy sends an operator to register an
    // executor that is registered and fine, when what is missing is this run's own claim.
    const error = await build(fakeExecutor())
      .pollJob({ jobId: 'x' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).details?.reason).toBe('delegated_claim_missing')
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
        blockId: 'blk_1',
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
