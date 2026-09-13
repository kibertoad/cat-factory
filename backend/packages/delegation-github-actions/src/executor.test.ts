import type {
  DelegatedFetch,
  DelegatedExecutorDeps,
  DelegationBrief,
  DelegationHandle,
  DelegationResult,
  DelegationUpdate,
} from '@cat-factory/kernel'
import { noopLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { correlationRunName } from './correlation.js'
import { githubActionsDelegatedExecutor } from './executor.js'

// The three problems this helper exists for, each asserted as the failure it prevents:
//
//   1. `workflow_dispatch` answers 204 with no run id, so a replayed dispatch would queue a SECOND
//      workflow: two workflows on one branch, two pull requests for one task.
//   2. Actions' conclusion vocabulary is not the platform's, and three of its values are the only
//      ones a fresh attempt could survive.
//   3. The workflow declares no outputs, so what it produced has to be found in the repository:
//      by the branch the platform named, and by nothing else.

interface Call {
  url: string
  method: string
  body?: unknown
}

/** A fetch double: routes by URL, records every call. */
function fakeFetch(routes: Record<string, () => { status?: number; body?: unknown }>): {
  fetchImpl: DelegatedFetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl: DelegatedFetch = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      ...(init?.body ? { body: JSON.parse(init.body) as unknown } : {}),
    })
    const route = Object.keys(routes).find((key) => url.includes(key))
    const answer = route ? routes[route]!() : { status: 404, body: { message: 'no route' } }
    const status = answer.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(answer.body ?? {}),
      json: async () => answer.body ?? {},
    }
  }
  return { fetchImpl, calls }
}

function deps(fetchImpl: DelegatedFetch): DelegatedExecutorDeps {
  return { logger: noopLogger, clock: { now: () => 0 }, fetchImpl }
}

const CREDS = { GITHUB_TOKEN: 'gh-token' }

/** The result of a settled poll, narrowed so an assertion can read its fields. */
function doneResult(update: DelegationUpdate): DelegationResult {
  if (update.state !== 'done') throw new Error(`expected a settled poll, got ${update.state}`)
  return update.result
}

function brief(): DelegationBrief {
  return {
    correlationKey: 'ex_1-acme:impl',
    workspaceId: 'ws_1',
    runId: 'ex_1',
    stepIndex: 0,
    agentKind: 'acme:impl',
    task: { id: 'blk_1', title: 'Add widget', description: 'Do it.' },
    repo: {
      owner: 'acme',
      name: 'widgets',
      cloneUrl: 'https://github.com/acme/widgets.git',
      provider: 'github',
    },
    branches: { base: 'main', work: 'cat-factory/blk_1' },
    systemPrompt: 'role',
    userPrompt: 'task',
    contextFiles: [],
    ownService: { stated: false, reason: 'not-under-a-service' },
  }
}

function handle(overrides: Partial<DelegationHandle> = {}): DelegationHandle {
  return {
    executor: 'acme:executor',
    correlationKey: 'ex_1-acme:impl',
    externalId: '4242',
    workspaceId: 'ws_1',
    runId: 'ex_1',
    agentKind: 'acme:impl',
    branches: { base: 'main', work: 'cat-factory/blk_1' },
    ...overrides,
  }
}

const DESCRIPTION = {
  owner: 'acme',
  repo: 'widgets',
  workflowFile: 'implement.yml',
  ref: 'main',
  inputs: (b: DelegationBrief) => ({ spec: b.userPrompt }),
}

const RUN = {
  id: 4242,
  name: `Implement ${correlationRunName('ex_1-acme:impl')}`,
  html_url: 'https://github.com/acme/widgets/actions/runs/4242',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-09-14T00:00:00Z',
}

describe('start: idempotency', () => {
  it('dispatches once and correlates the run it queued', async () => {
    let listed = 0
    const { fetchImpl, calls } = fakeFetch({
      '/dispatches': () => ({ status: 204 }),
      '/runs?': () => ({
        body: { workflow_runs: listed++ === 0 ? [] : [{ ...RUN, status: 'queued' }] },
      }),
    })
    const executor = githubActionsDelegatedExecutor(DESCRIPTION, deps(fetchImpl))
    const start = await executor.start(brief(), CREDS)
    expect(start.externalId).toBe('4242')
    expect(calls.filter((c) => c.url.includes('/dispatches'))).toHaveLength(1)
    // The correlation key travels as a workflow input, which is what lets the caller workflow put
    // it in its own `run-name`.
    expect(calls.find((c) => c.url.includes('/dispatches'))?.body).toMatchObject({
      ref: 'main',
      inputs: { correlation: 'ex_1-acme:impl', spec: 'task' },
    })
  })

  it('RE-ATTACHES instead of dispatching a second workflow', async () => {
    // The deadliest failure in the seam: both durable drivers replay, and two workflows working
    // one branch open two pull requests for one task.
    const { fetchImpl, calls } = fakeFetch({
      '/dispatches': () => ({ status: 204 }),
      '/runs?': () => ({ body: { workflow_runs: [{ ...RUN, status: 'in_progress' }] } }),
    })
    const executor = githubActionsDelegatedExecutor(DESCRIPTION, deps(fetchImpl))
    const start = await executor.start(brief(), CREDS)
    expect(start.externalId).toBe('4242')
    expect(calls.filter((c) => c.url.includes('/dispatches'))).toHaveLength(0)
  })

  it('records the correlation key when the run has not appeared yet', async () => {
    // Refusing here would fail a step whose workflow is queued and about to run; the first poll
    // recovers the real id.
    const { fetchImpl } = fakeFetch({
      '/dispatches': () => ({ status: 204 }),
      '/runs?': () => ({ body: { workflow_runs: [] } }),
    })
    const executor = githubActionsDelegatedExecutor(DESCRIPTION, deps(fetchImpl))
    const start = await executor.start(brief(), CREDS)
    expect(start.externalId).toBe('ex_1-acme:impl')
    expect(start.note).toContain('correlated on the first poll')
  })

  it('refuses without a token rather than letting a 404 read as a missing workflow', async () => {
    const { fetchImpl } = fakeFetch({})
    const executor = githubActionsDelegatedExecutor(DESCRIPTION, deps(fetchImpl))
    await expect(executor.start(brief(), {})).rejects.toThrow(/No GitHub token resolved/)
  })
})

describe('poll: conclusions', () => {
  const pollWith = async (
    run: Record<string, unknown>,
    routes: Record<string, () => { body?: unknown }> = {},
  ) => {
    const { fetchImpl } = fakeFetch({
      '/actions/runs/4242': () => ({ body: run }),
      '/pulls?': () => ({ body: [] }),
      ...routes,
    })
    return githubActionsDelegatedExecutor(DESCRIPTION, deps(fetchImpl)).poll(handle(), CREDS)
  }

  it('reports a run still going as running, with its own phase', async () => {
    expect(await pollWith({ ...RUN, status: 'in_progress', conclusion: null })).toMatchObject({
      state: 'running',
      phase: 'in_progress',
      url: RUN.html_url,
    })
  })

  it('reports a queued run as running even before it can be found', async () => {
    const { fetchImpl } = fakeFetch({ '/runs?': () => ({ body: { workflow_runs: [] } }) })
    const update = await githubActionsDelegatedExecutor(DESCRIPTION, deps(fetchImpl)).poll(
      handle({ externalId: 'ex_1-acme:impl' }),
      CREDS,
    )
    expect(update).toMatchObject({ state: 'running', phase: 'queued' })
  })

  it('marks a failure TERMINAL unless the conclusion is one a retry could survive', async () => {
    const failed = await pollWith({ ...RUN, conclusion: 'failure' })
    expect(failed).toMatchObject({ state: 'failed' })
    expect(failed).not.toHaveProperty('retryable')
    for (const conclusion of ['cancelled', 'timed_out', 'stale']) {
      expect(await pollWith({ ...RUN, conclusion })).toMatchObject({
        state: 'failed',
        retryable: true,
      })
    }
  })
})

describe('poll: what the run produced', () => {
  it('finds the pull request by the branch the PLATFORM named', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/actions/runs/4242': () => ({ body: RUN }),
      '/pulls?': () => ({
        body: [
          {
            number: 9,
            html_url: 'https://github.com/acme/widgets/pull/9',
            head: { ref: 'cat-factory/blk_1' },
          },
        ],
      }),
    })
    const update = await githubActionsDelegatedExecutor(DESCRIPTION, deps(fetchImpl)).poll(
      handle(),
      CREDS,
    )
    expect(update).toMatchObject({
      state: 'done',
      result: { pullRequest: { number: 9, branch: 'cat-factory/blk_1' } },
    })
    expect(calls.some((c) => c.url.includes('acme%3Acat-factory%2Fblk_1'))).toBe(true)
  })

  it('records NO pull request rather than a wrong one when the head does not match', async () => {
    // A wrong PR on the block is worse than none: the `ci` gate would poll somebody else's checks
    // and the merger would consider somebody else's diff.
    const { fetchImpl } = fakeFetch({
      '/actions/runs/4242': () => ({ body: RUN }),
      '/pulls?': () => ({
        body: [{ number: 3, html_url: 'https://x/3', head: { ref: 'someone-else' } }],
      }),
    })
    const update = await githubActionsDelegatedExecutor(DESCRIPTION, deps(fetchImpl)).poll(
      handle(),
      CREDS,
    )
    expect(update).toMatchObject({ state: 'done' })
    expect(doneResult(update)).not.toHaveProperty('pullRequest')
  })

  it('REFUSES to guess when the record carries no work branch', async () => {
    const { fetchImpl, calls } = fakeFetch({ '/actions/runs/4242': () => ({ body: RUN }) })
    const update = await githubActionsDelegatedExecutor(DESCRIPTION, deps(fetchImpl)).poll(
      { ...handle(), branches: undefined },
      CREDS,
    )
    expect(update).toMatchObject({ state: 'done' })
    expect(doneResult(update).summary).toContain('records no work branch')
    expect(calls.some((c) => c.url.includes('/pulls'))).toBe(false)
  })

  it('keeps the run SUCCESSFUL when its result cannot be read', async () => {
    // The workflow succeeded and the change is pushed; reporting that as a failed step would hide
    // work that already landed.
    const { fetchImpl } = fakeFetch({
      '/actions/runs/4242': () => ({ body: RUN }),
      '/pulls?': () => ({ status: 500, body: { message: 'boom' } }),
    })
    const update = await githubActionsDelegatedExecutor(DESCRIPTION, deps(fetchImpl)).poll(
      handle(),
      CREDS,
    )
    expect(update).toMatchObject({ state: 'done' })
    expect(doneResult(update).summary).toContain('failed')
  })
})

describe('cancel', () => {
  it('cancels a live run', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/actions/runs/4242/cancel': () => ({ status: 202 }),
      '/actions/runs/4242': () => ({ body: { ...RUN, status: 'in_progress', conclusion: null } }),
    })
    await githubActionsDelegatedExecutor(DESCRIPTION, deps(fetchImpl)).cancel?.(handle(), CREDS)
    expect(calls.some((c) => c.url.endsWith('/cancel') && c.method === 'POST')).toBe(true)
  })

  it('treats an already-finished run as nothing to cancel', async () => {
    const { fetchImpl, calls } = fakeFetch({ '/actions/runs/4242': () => ({ body: RUN }) })
    await githubActionsDelegatedExecutor(DESCRIPTION, deps(fetchImpl)).cancel?.(handle(), CREDS)
    expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(false)
  })
})
