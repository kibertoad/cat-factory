import type {
  DelegatedFetch,
  DelegatedExecutorDeps,
  DelegationBrief,
  DelegationHandle,
  DelegationResult,
  DelegationUpdate,
} from '@cat-factory/kernel'
import { createRecordingLogger, noopLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { correlationRunName } from './correlation.js'
import { githubActionsDelegatedExecutor } from './executor.js'
import type { GitHubActionsWorkflowScope } from './workflow.js'

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
    blockId: 'blk_1',
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
    blockId: 'blk_1',
    runId: 'ex_1',
    agentKind: 'acme:impl',
    branches: { base: 'main', work: 'cat-factory/blk_1' },
    ...overrides,
  }
}

const WORKFLOW = {
  owner: 'acme',
  repo: 'widgets',
  workflowFile: 'implement.yml',
  ref: 'main',
}

const DESCRIPTION = {
  workflow: WORKFLOW,
  inputs: (b: DelegationBrief) => ({ spec: b.userPrompt }),
}

// Shaped as GitHub actually answers: `name` keeps the WORKFLOW's own `name:` whatever the
// workflow's `run-name:` renders, and the evaluated `run-name:` lands in `display_title`. Modelling
// the marker on `name` is what let the correlation read the wrong field with a green suite.
const RUN = {
  id: 4242,
  name: 'Implement',
  display_title: `Implement ${correlationRunName('ex_1-acme:impl')}`,
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

describe('correlation: which field carries the marker', () => {
  const listing = (runs: unknown[]) =>
    githubActionsDelegatedExecutor(
      DESCRIPTION,
      deps(fakeFetch({ '/runs?': () => ({ body: { workflow_runs: runs } }) }).fetchImpl),
    ).poll(handle({ externalId: 'ex_1-acme:impl' }), CREDS)

  it('correlates on `display_title`, where a workflow’s `run-name:` actually lands', async () => {
    // `name` stays the workflow's own title, so matching the marker against it finds nothing ever:
    // no run correlates, `start` loses its idempotency look-up (a replay queues a SECOND workflow
    // and the task gets two pull requests), and every poll answers "queued" until the budget dies.
    expect(await listing([{ ...RUN, status: 'in_progress', conclusion: null }])).toMatchObject({
      state: 'running',
      url: RUN.html_url,
    })
  })

  it('still correlates on `name` alone, for an Enterprise release without `display_title`', async () => {
    const legacy = {
      ...RUN,
      display_title: undefined,
      name: `Implement ${correlationRunName('ex_1-acme:impl')}`,
      status: 'in_progress',
      conclusion: null,
    }
    expect(await listing([legacy])).toMatchObject({ state: 'running', url: RUN.html_url })
  })

  it('picks the NEWEST match by `created_at`, never the first element GitHub happened to send', async () => {
    // Newest-first is an UNDOCUMENTED default of this endpoint: no `sort`/`direction` is passed,
    // nothing promises it, and a deployment's proxy is free to re-order. Trusting element order,
    // a re-attach lands on an OLD completed run carrying the same marker and the step settles on
    // a workflow that finished hours earlier.
    const older = {
      ...RUN,
      id: 1111,
      created_at: '2026-09-13T00:00:00Z',
      status: 'completed',
      conclusion: 'failure',
    }
    const newer = {
      ...RUN,
      id: 9999,
      created_at: '2026-09-14T10:00:00Z',
      html_url: 'https://github.com/acme/widgets/actions/runs/9999',
      status: 'in_progress',
      conclusion: null,
    }
    // Oldest FIRST, which is exactly the ordering `find` would have taken.
    expect(await listing([older, newer])).toMatchObject({
      state: 'running',
      externalId: '9999',
      url: newer.html_url,
    })
  })

  it('breaks a same-second tie on the run id, which Actions makes monotonic', async () => {
    // `created_at` has one-second granularity, which is the whole reason the marker exists.
    const first = { ...RUN, id: 5000, status: 'in_progress', conclusion: null }
    const second = {
      ...RUN,
      id: 5001,
      html_url: 'https://github.com/acme/widgets/actions/runs/5001',
      status: 'in_progress',
      conclusion: null,
    }
    expect(await listing([second, first])).toMatchObject({ externalId: '5001' })
  })

  it('reports the recovered id on EVERY running poll, so the scan stops being re-run', async () => {
    // `start` answers with the correlation key when the run had not appeared yet. Left uncarried,
    // the record keeps that key for the life of the run and each poll re-runs the bounded page
    // scan, which a busy repository eventually pushes the run off the end of.
    expect(await listing([{ ...RUN, status: 'in_progress', conclusion: null }])).toMatchObject({
      externalId: '4242',
    })
  })

  it('does NOT correlate a run of the same workflow started by something else', async () => {
    // The marker is the whole identity: without it, two dispatches in the same second are
    // indistinguishable and the platform settles a step against somebody else's run.
    const other = {
      ...RUN,
      display_title: `Implement ${correlationRunName('ex_9-acme:impl')}`,
      status: 'in_progress',
      conclusion: null,
    }
    expect(await listing([other])).toMatchObject({ state: 'running', phase: 'queued' })
  })
})

describe('poll: what the run produced', () => {
  it('reads the pull request out of the repo the WORK targeted, not the one holding the workflow', async () => {
    // `description.ref` is a branch that HOLDS the workflow, so a central automation repo
    // dispatching against many product repos is the ordinary shape. Reading the result out of the
    // automation repo finds nothing there and reports every run as having opened no pull request.
    const { fetchImpl, calls } = fakeFetch({
      '/actions/runs/4242': () => ({ body: RUN }),
      '/repos/acme/widgets/pulls?': () => ({
        body: [
          {
            number: 9,
            html_url: 'https://github.com/acme/widgets/pull/9',
            head: { ref: 'cat-factory/blk_1' },
          },
        ],
      }),
    })
    const automation = { ...DESCRIPTION, workflow: { ...WORKFLOW, repo: 'automation' } }
    const update = await githubActionsDelegatedExecutor(automation, deps(fetchImpl)).poll(
      handle({ repo: { owner: 'acme', name: 'widgets' } }),
      CREDS,
    )
    expect(update).toMatchObject({ state: 'done', result: { pullRequest: { number: 9 } } })
    // The RUN is addressed in the workflow's repo and the RESULT in the work's: two repos, two
    // reads, and conflating them is the bug.
    expect(calls.some((c) => c.url.includes('/repos/acme/automation/actions/runs/4242'))).toBe(true)
  })

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

describe('a workflow resolved per dispatch', () => {
  // A caller shim committed to each onboarded repository means the workflow lives wherever the
  // work does, so one registration dispatches against every repo a deployment onboards. A fixed
  // owner/repo made the dispatch the only part of this helper that could not follow the brief.
  const perRepo = {
    ...DESCRIPTION,
    workflow: (scope: GitHubActionsWorkflowScope) => ({
      owner: scope.repo.owner,
      repo: scope.repo.name,
      workflowFile: 'cat-factory-ratchet.yml',
      ref: 'main',
    }),
  }

  it('dispatches into the repository the WORK targets', async () => {
    let listed = 0
    const { fetchImpl, calls } = fakeFetch({
      '/dispatches': () => ({ status: 204 }),
      '/runs?': () => ({
        body: { workflow_runs: listed++ === 0 ? [] : [{ ...RUN, status: 'queued' }] },
      }),
    })
    const target = { ...brief(), repo: { ...brief().repo, owner: 'acme', name: 'payments' } }
    await githubActionsDelegatedExecutor(perRepo, deps(fetchImpl)).start(target, CREDS)
    expect(
      calls.some((c) =>
        c.url.includes('/repos/acme/payments/actions/workflows/cat-factory-ratchet.yml/dispatches'),
      ),
    ).toBe(true)
  })

  it('addresses the SAME repository on a later poll, which holds only the handle', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/actions/runs/4242': () => ({ body: { ...RUN, status: 'in_progress', conclusion: null } }),
    })
    // The scope is the intersection of a brief and a handle for exactly this reason: a resolver
    // reading a brief-only fact would dispatch into one repository and poll another, and the run
    // would read as one that never appeared.
    const update = await githubActionsDelegatedExecutor(perRepo, deps(fetchImpl)).poll(
      handle({ repo: { owner: 'acme', name: 'payments' } }),
      CREDS,
    )
    expect(update).toMatchObject({ state: 'running' })
    expect(calls.some((c) => c.url.includes('/repos/acme/payments/actions/runs/4242'))).toBe(true)
  })

  it('hands the resolver the base branch, from the brief and from the handle alike', async () => {
    // A caller shim is dispatched on the branch that holds it, which is the work repository's own
    // base. Without it on the scope every deployment restated the default-branch name per repo.
    const refs: string[] = []
    const onBase = {
      ...DESCRIPTION,
      workflow: (scope: GitHubActionsWorkflowScope) => {
        refs.push(scope.baseBranch)
        return {
          owner: scope.repo.owner,
          repo: scope.repo.name,
          workflowFile: 'w.yml',
          ref: scope.baseBranch,
        }
      },
    }
    const { fetchImpl, calls } = fakeFetch({
      '/dispatches': () => ({ status: 204 }),
      '/runs?': () => ({ body: { workflow_runs: [] } }),
      '/actions/runs/4242': () => ({ body: { ...RUN, status: 'in_progress', conclusion: null } }),
    })
    const executor = githubActionsDelegatedExecutor(onBase, deps(fetchImpl))
    await executor.start(
      { ...brief(), branches: { base: 'master', work: 'cat-factory/blk_1' } },
      CREDS,
    )
    await executor.poll(
      handle({
        repo: { owner: 'acme', name: 'widgets' },
        branches: { base: 'master', work: 'cat-factory/blk_1' },
      }),
      CREDS,
    )
    expect(refs).toEqual(['master', 'master'])
    expect(calls.find((c) => c.url.includes('/dispatches'))?.body).toMatchObject({ ref: 'master' })
  })

  it('REFUSES a handle that names no base branch rather than assuming one', async () => {
    const { fetchImpl } = fakeFetch({ '/actions/runs/4242': () => ({ body: RUN }) })
    await expect(
      githubActionsDelegatedExecutor(perRepo, deps(fetchImpl)).poll(
        handle({ repo: { owner: 'acme', name: 'widgets' }, branches: undefined }),
        CREDS,
      ),
    ).rejects.toThrow(/no base branch/)
  })

  it('REFUSES a handle that names no work repository rather than guessing one', async () => {
    const { fetchImpl } = fakeFetch({ '/actions/runs/4242': () => ({ body: RUN }) })
    await expect(
      githubActionsDelegatedExecutor(perRepo, deps(fetchImpl)).poll(
        handle({ repo: undefined }),
        CREDS,
      ),
    ).rejects.toThrow(/no work repository/)
  })

  it('names the repository it addressed on every line it logs', async () => {
    // With a resolver, the repository is a per-call fact. Bound once at build, a deployment
    // onboarding fifty of them reads fifty identical "result could not be read" warnings and
    // cannot tell one misconfigured repository from a token that is wrong everywhere.
    const recording = createRecordingLogger()
    const { fetchImpl } = fakeFetch({
      '/actions/runs/4242': () => ({ body: RUN }),
      '/pulls?': () => ({ status: 500, body: { message: 'boom' } }),
    })
    await githubActionsDelegatedExecutor(perRepo, {
      ...deps(fetchImpl),
      logger: recording,
    }).poll(handle({ repo: { owner: 'acme', name: 'payments' } }), CREDS)
    expect(recording.lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({ repo: 'acme/payments' }),
      }),
    )
  })

  it('asks the resolver ONCE per call, not once per use of what it answered', async () => {
    // A deployment's resolver is its own code with no purity requirement: one that reads a
    // per-repo config map, logs, or counts a metric must see one addressing decision per call.
    // A settling poll is the worst case, because the result read needs the location too.
    let resolved = 0
    const counted = {
      ...perRepo,
      workflow: (scope: GitHubActionsWorkflowScope) => {
        resolved += 1
        return {
          owner: scope.repo.owner,
          repo: scope.repo.name,
          workflowFile: 'w.yml',
          ref: 'main',
        }
      },
    }
    const { fetchImpl } = fakeFetch({
      '/actions/runs/4242': () => ({ body: RUN }),
      '/pulls?': () => ({ body: [] }),
    })
    const executor = githubActionsDelegatedExecutor(counted, deps(fetchImpl))
    await executor.poll(handle({ repo: { owner: 'acme', name: 'payments' } }), CREDS)
    expect(resolved).toBe(1)
    await executor.cancel?.(handle({ repo: { owner: 'acme', name: 'payments' } }), CREDS)
    expect(resolved).toBe(2)
  })

  it('leaves a LITERAL description addressable from a handle that predates the work repo', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/actions/runs/4242': () => ({ body: RUN }),
      '/pulls?': () => ({ body: [] }),
    })
    const update = await githubActionsDelegatedExecutor(DESCRIPTION, deps(fetchImpl)).poll(
      handle({ repo: undefined }),
      CREDS,
    )
    expect(update).toMatchObject({ state: 'done' })
    expect(calls.some((c) => c.url.includes('/repos/acme/widgets/pulls?'))).toBe(true)
  })
})
