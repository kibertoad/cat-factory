import { describe, expect, it } from 'vitest'
import { CatFactoryNotFoundError, CatFactoryValidationError } from '@cat-factory/sdk'
import type { BoardConfig } from '../src/config.ts'
import { serviceTitles } from '../src/instructions.ts'
import {
  applyReset,
  formatResetPlan,
  formatResetReport,
  parseResetArgs,
  planReset,
  type ResetClient,
  type ResetPassOnDisk,
  type ResetPlan,
  resetSucceeded,
} from '../src/reset.ts'
import type { World } from '../src/world.ts'
import { emptyWorld } from '../src/world.ts'

// What is pinned here is the part of a reset that cannot be checked by running one: this deletes real
// service frames and real run history, so the interesting properties are which frames end up in the
// plan (two independent questions, unioned), the ORDER of the writes (tasks before their frame, which
// is what stops the frame delete refusing), and the two ways a reset must refuse to make things
// worse: a ledger removed while its frame survives, and a `latest` pointer left naming a deleted one.

const CONFIG: BoardConfig = {
  baseUrl: 'http://127.0.0.1:8787',
  apiKey: 'cf_live_key',
  workspaceId: 'ws_1',
  repoOwner: 'acme',
  namePrefix: 'cf-acc',
  repos: { backend: 'catalog-api', frontend: 'catalog-web' },
  stateDir: '/state',
}

const TITLES = serviceTitles(CONFIG.namePrefix)

type Fake = {
  client: ResetClient
  /** Every write, in the order it was made: `task:<id>` / `service:<id>`. */
  calls: string[]
  /** Files removed, in order. */
  removed: string[]
  files: { remove(path: string): boolean }
}

function fake(
  options: {
    repos?: readonly { name: string; serviceId?: string | null; linkedElsewhere?: boolean }[]
    services?: readonly { serviceId: string; title: string }[]
    /** Unfinished tasks per frame: the ones the frame delete would refuse over. */
    tasks?: Readonly<Record<string, readonly string[]>>
    /** Finished ones, which the frame delete cascades and this command never calls about. */
    doneTasks?: Readonly<Record<string, readonly string[]>>
    /** Service ids whose delete refuses, and the reason the surface publishes for each. */
    refuseService?: Readonly<Record<string, string | null>>
    /** Task ids whose delete throws something other than a 404. */
    failTask?: readonly string[]
    /** Task ids the deployment reports as already gone. */
    goneTask?: readonly string[]
    /** Paths the file remover finds nothing at. */
    absentFiles?: readonly string[]
  } = {},
): Fake {
  const calls: string[] = []
  const removed: string[] = []
  const state: Fake = {
    calls,
    removed,
    files: {
      remove: (path) => {
        if ((options.absentFiles ?? []).includes(path)) return false
        removed.push(path)
        return true
      },
    },
    client: {
      repos: async () =>
        (options.repos ?? []).map((repo) => ({
          owner: CONFIG.repoOwner,
          name: repo.name,
          serviceId: repo.serviceId ?? null,
          linkedElsewhere: repo.linkedElsewhere ?? false,
        })),
      services: async () => options.services ?? [],
      tasks: async (serviceId) => [
        ...(options.tasks?.[serviceId] ?? []).map((taskId) => ({
          taskId,
          title: `task ${taskId}`,
          done: false,
        })),
        ...(options.doneTasks?.[serviceId] ?? []).map((taskId) => ({
          taskId,
          title: `task ${taskId}`,
          done: true,
        })),
      ],
      deleteTask: async (taskId) => {
        calls.push(`task:${taskId}`)
        if ((options.goneTask ?? []).includes(taskId)) throw notFound('Task')
        if ((options.failTask ?? []).includes(taskId)) throw new Error('boom')
      },
      deleteService: async (serviceId) => {
        calls.push(`service:${serviceId}`)
        const refusal = options.refuseService?.[serviceId]
        if (refusal !== undefined) throw refused(refusal)
      },
    },
  }
  return state
}

function notFound(resource: string): CatFactoryNotFoundError {
  return new CatFactoryNotFoundError({
    status: 404,
    code: 'not_found',
    message: `${resource} not found`,
    details: { reason: 'service_not_found' },
    requestId: null,
    body: null,
  })
}

function refused(reason: string | null): CatFactoryValidationError {
  return new CatFactoryValidationError({
    status: 422,
    code: 'validation',
    message: 'This service has 1 unfinished task(s); archive it instead of deleting.',
    details: reason === null ? {} : { reason },
    requestId: null,
    body: null,
  })
}

/** A pass on disk whose ledger names the given services. */
function ledger(
  runId: string,
  services: { backend?: string; frontend?: string; issueUrl?: string } = {},
): ResetPassOnDisk {
  const world: World = {
    ...emptyWorld(runId),
    ...(services.backend
      ? { backend: { blockId: services.backend, serviceId: services.backend, repoName: 'a/b' } }
      : {}),
    ...(services.frontend
      ? { frontend: { blockId: services.frontend, serviceId: services.frontend, repoName: 'a/c' } }
      : {}),
    ...(services.issueUrl
      ? {
          intakeIssue: {
            provider: 'github',
            owner: 'acme',
            repo: 'catalog-api',
            number: 7,
            url: services.issueUrl,
          },
        }
      : {}),
  }
  return {
    runId,
    ledgerPath: `/state/${runId}.json`,
    journalPath: `/state/${runId}.journal.jsonl`,
    world,
  }
}

function input(overrides: Partial<Parameters<typeof planReset>[1]> = {}) {
  return {
    config: CONFIG,
    namedRunId: null,
    all: false,
    passes: [],
    // No pointer FILE, which is a different state from one naming nothing: see `readLatestPointer`.
    latest: null,
    ...overrides,
  }
}

describe('planReset', () => {
  it('plans the frame a target repository backs, with the tasks under it', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }, { name: 'catalog-web' }],
      services: [{ serviceId: 'blk_api', title: 'Renamed by hand' }],
      tasks: { blk_api: ['blk_t1', 'blk_t2'] },
    })

    const plan = await planReset(f.client, input())

    expect(plan.frames).toHaveLength(1)
    expect(plan.frames[0]?.serviceId).toBe('blk_api')
    expect(plan.frames[0]?.reasons).toEqual([{ kind: 'backs-repo', slug: 'acme/catalog-api' }])
    expect(plan.frames[0]?.tasks.map((task) => task.taskId)).toEqual(['blk_t1', 'blk_t2'])
  })

  it('plans a frame that took a pass TITLE even when it backs neither repository', async () => {
    // The second refusal a reset answers (`board-titles`), and the reason the plan is a union: a
    // frame whose repository was re-pointed by hand keeps the title, and a plan built from the
    // repositories alone would clear the board and leave that gate still firing.
    const f = fake({
      repos: [{ name: 'catalog-api' }, { name: 'catalog-web' }],
      services: [
        { serviceId: 'blk_old', title: TITLES.backend },
        { serviceId: 'blk_other', title: 'Somebody else’s service' },
      ],
    })

    const plan = await planReset(f.client, input())

    expect(plan.frames.map((frame) => frame.serviceId)).toEqual(['blk_old'])
    expect(plan.frames[0]?.reasons).toEqual([{ kind: 'holds-title', title: TITLES.backend }])
  })

  it('states every reason one frame is in the plan, rather than the first that matched', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
      tasks: {},
    })

    const plan = await planReset(
      f.client,
      input({ passes: [ledger('p1', { backend: 'blk_api' })] }),
    )

    expect(plan.frames[0]?.reasons).toEqual([
      { kind: 'backs-repo', slug: 'acme/catalog-api' },
      { kind: 'holds-title', title: TITLES.backend },
    ])
    // The pass is not NAMED, so its ledger did not widen the target; it is still in the plan,
    // because the frame it names is being deleted and a stale ledger would resume onto nothing.
    expect(plan.passes.map((pass) => pass.runId)).toEqual(['p1'])
  })

  it('widens to what a NAMED pass holds, including a frame this configuration no longer points at', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api' }],
      services: [{ serviceId: 'blk_stale', title: 'old-prefix Catalog API' }],
    })

    const plan = await planReset(
      f.client,
      input({ namedRunId: 'p1', passes: [ledger('p1', { backend: 'blk_stale' })] }),
    )

    expect(plan.frames.map((frame) => frame.serviceId)).toEqual(['blk_stale'])
    expect(plan.frames[0]?.reasons).toEqual([{ kind: 'named-by-pass', runId: 'p1' }])
  })

  it('leaves an unrelated pass’s files alone', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
    })

    const plan = await planReset(
      f.client,
      input({
        passes: [ledger('mine', { backend: 'blk_api' }), ledger('theirs', { backend: 'blk_zzz' })],
      }),
    )

    expect(plan.passes.map((pass) => pass.runId)).toEqual(['mine'])
  })

  it('reports a frame the board no longer lists as absent, and asks it for no tasks', async () => {
    const f = fake({ repos: [{ name: 'catalog-api', serviceId: 'blk_gone' }], services: [] })

    const plan = await planReset(f.client, input())

    expect(plan.frames[0]?.absent).toBe(true)
    expect(plan.frames[0]?.tasks).toEqual([])
    expect(plan.frames[0]?.title).toBeNull()
  })

  it('states a repository it cannot free as unfreeable rather than as nothing to do', async () => {
    // `serviceId: null` with `linkedElsewhere` is a frame no workspace-scoped key can address, and
    // TWO states answer that way: homed on another board, or archived here. Read as "available",
    // the reset reports success and the next pass earns the same refusal.
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: null, linkedElsewhere: true }],
      services: [],
    })

    const plan = await planReset(f.client, input())

    expect(plan.frames).toEqual([])
    expect(plan.stuck.map((entry) => entry.slug)).toEqual(['acme/catalog-api'])
    expect(plan.stuck[0]?.steps.join(' ')).toContain('repo_service_homed_elsewhere')
    // Both readings, because this read cannot tell them apart and their fixes are opposite.
    expect(plan.stuck[0]?.steps.join(' ')).toContain('ARCHIVED')
  })

  it('names the pointer only when it names a pass in the plan', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
    })
    const passes = [ledger('mine', { backend: 'blk_api' }), ledger('theirs', { backend: 'blk_z' })]

    const mine = await planReset(
      f.client,
      input({ passes, latest: { runId: 'mine', path: '/state/latest.json' } }),
    )
    const theirs = await planReset(
      f.client,
      input({ passes, latest: { runId: 'theirs', path: '/state/latest.json' } }),
    )

    expect(mine.pointer).toEqual({ runId: 'mine', path: '/state/latest.json' })
    expect(theirs.pointer).toBeNull()
  })

  it('takes a DANGLING pointer under --all, which is the scope that clears the directory', async () => {
    // A pointer whose ledger someone removed by hand (or a malformed one) names no pass, so no
    // branch keyed on a planned pass reaches it, and it outlives every file `--all` deletes.
    // `ACCEPTANCE_RUN_ID=latest` then resolves against a state directory with no ledgers at all,
    // which is the same "fresh pass wearing a finished pass's run id" the removal exists against.
    const f = fake({ repos: [{ name: 'catalog-api' }], services: [] })
    const dangling = { runId: null, path: '/state/latest.json' }

    const whole = await planReset(f.client, input({ all: true, latest: dangling }))
    const narrow = await planReset(f.client, input({ latest: dangling }))

    expect(whole.pointer).toEqual(dangling)
    expect(narrow.pointer).toBeNull()
  })

  it('names no pointer when the state directory holds no pointer FILE', async () => {
    // "Absent" and "names nothing" are different states, and only the second is a file to remove:
    // announcing a removal for a file that was never there is the preview misstating its outcome.
    const f = fake({ repos: [{ name: 'catalog-api' }], services: [] })

    expect((await planReset(f.client, input({ all: true, latest: null }))).pointer).toBeNull()
  })

  it('takes every frame the board lists under --all, whatever backs it or calls it', async () => {
    // The frames the two configured questions structurally cannot see: a pass run under a different
    // `ACCEPTANCE_NAME_PREFIX`, and one raised by hand. Neither backs a target repository nor holds
    // one of this prefix's titles, so neither blocks a pass and neither is reachable without `--all`.
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [
        { serviceId: 'blk_api', title: TITLES.backend },
        { serviceId: 'blk_old', title: 'old-prefix Catalog Web' },
        { serviceId: 'blk_hand', title: 'Scratch service' },
      ],
      tasks: { blk_old: ['blk_t9'] },
    })

    const plan = await planReset(f.client, input({ all: true }))

    expect(plan.scope).toBe('whole-board')
    expect(plan.frames.map((frame) => frame.serviceId)).toEqual(['blk_api', 'blk_old', 'blk_hand'])
    // The frame the narrow questions already claimed keeps naming the refusal it would have earned;
    // `whole-board` alone is what marks one no configured pass would ever have touched.
    expect(plan.frames[0]?.reasons).toEqual([
      { kind: 'backs-repo', slug: 'acme/catalog-api' },
      { kind: 'holds-title', title: TITLES.backend },
      { kind: 'whole-board' },
    ])
    expect(plan.frames[1]?.reasons).toEqual([{ kind: 'whole-board' }])
    // Tasks are read for a frame `--all` alone put in the plan, or its delete refuses over them.
    expect(plan.frames[1]?.tasks.map((task) => task.taskId)).toEqual(['blk_t9'])
  })

  it('takes every pass on disk under --all, including one whose ledger names nothing', async () => {
    // A board with no frames left holds nothing for any ledger to map, so a file kept back is a run
    // id `status` still lists and `latest` may still resolve to, which resumes onto frames that no
    // longer exist. A refused attempt (no readable ledger) names no frame at all, so it is
    // unreachable through the `holdsDoomed` branch and would survive every narrow reset.
    const f = fake({
      repos: [{ name: 'catalog-api' }],
      services: [{ serviceId: 'blk_hand', title: 'Scratch service' }],
    })
    const refusedAttempt: ResetPassOnDisk = {
      runId: 'p_refused',
      ledgerPath: '/state/p_refused.json',
      journalPath: '/state/p_refused.journal.jsonl',
      world: null,
    }

    const narrow = await planReset(f.client, input({ passes: [refusedAttempt] }))
    const whole = await planReset(f.client, input({ all: true, passes: [refusedAttempt] }))

    expect(narrow.passes).toEqual([])
    expect(whole.passes.map((pass) => pass.runId)).toEqual(['p_refused'])
    // Nothing it names survives on the board, so its files go rather than being kept as a map.
    expect(whole.passes[0]?.unreclaimed).toEqual([])
    const report = await applyReset(f.client, f.files, whole)
    expect(report.passes[0]?.kept).toBeNull()
  })

  it('names a repository a deleted frame backed BEYOND the configured two', async () => {
    // Under `--all` the leftovers paragraph's two repositories are a fraction of what was emptied,
    // and a repository whose content survives is the leftover that changes what the next pass does.
    const f = fake({
      repos: [
        { name: 'catalog-api', serviceId: 'blk_api' },
        { name: 'unrelated-svc', serviceId: 'blk_other' },
      ],
      services: [
        { serviceId: 'blk_api', title: TITLES.backend },
        { serviceId: 'blk_other', title: 'Somebody else’s service' },
      ],
    })

    const plan = await planReset(f.client, input({ all: true }))

    const notes = plan.leftovers.join('\n')
    expect(notes).toContain('acme/unrelated-svc')
    // The configured pair is named by the paragraph that always runs, so it is not repeated here.
    expect(plan.leftovers[0]).not.toContain('catalog-api')
  })

  it('always states what it cannot reclaim, naming the repositories and any filed issue', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
    })

    const plan = await planReset(
      f.client,
      input({
        passes: [
          ledger('p1', { backend: 'blk_api', issueUrl: 'https://github.com/acme/x/issues/7' }),
        ],
      }),
    )

    const notes = plan.leftovers.join('\n')
    expect(notes).toContain('acme/catalog-api')
    expect(notes).toContain('https://github.com/acme/x/issues/7')
    expect(notes).toContain('ACCEPTANCE_K3S_NAMESPACE_TEMPLATE')
  })
})

describe('applyReset', () => {
  async function planFor(f: Fake, over: Partial<Parameters<typeof planReset>[1]> = {}) {
    return planReset(f.client, input(over))
  }

  it('deletes every task BEFORE its frame, which is what stops the frame delete refusing', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
      tasks: { blk_api: ['blk_t1', 'blk_t2'] },
    })
    const plan = await planFor(f)

    const report = await applyReset(f.client, f.files, plan)

    expect(f.calls).toEqual(['task:blk_t1', 'task:blk_t2', 'service:blk_api'])
    expect(report.frames[0]?.outcome).toEqual({ status: 'deleted' })
    expect(report.frames[0]?.deletedTasks).toEqual(['blk_t1', 'blk_t2'])
    expect(resetSucceeded(report)).toBe(true)
  })

  it('calls about the UNFINISHED tasks only, since the frame delete cascades the rest', async () => {
    // What the individual deletes are FOR is the frame delete's guard, which counts only unfinished
    // work. A finished pass leaves dozens of `done` tasks per frame, and each delete costs the
    // deployment two whole-board reads for something the one frame delete does anyway.
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
      tasks: { blk_api: ['blk_open'] },
      doneTasks: { blk_api: ['blk_done1', 'blk_done2'] },
    })
    const plan = await planFor(f)

    // The PLAN still names every task, because they all disappear and the preview says what does.
    expect(plan.frames[0]?.tasks.map((task) => task.taskId)).toEqual([
      'blk_open',
      'blk_done1',
      'blk_done2',
    ])
    const report = await applyReset(f.client, f.files, plan)
    expect(f.calls).toEqual(['task:blk_open', 'service:blk_api'])
    expect(report.frames[0]?.deletedTasks).toEqual(['blk_open'])
  })

  it('finishes one frame before starting the next, rather than deleting every task first', async () => {
    // Per-frame sequencing is what the frame delete's refusal needs: a frame whose own tasks are gone
    // can be deleted while another frame's are still there. Batching every task first would work too
    // and would leave a failure mid-flight having emptied frames nothing then removed.
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [
        { serviceId: 'blk_api', title: TITLES.backend },
        { serviceId: 'blk_hand', title: 'Scratch service' },
      ],
      tasks: { blk_api: ['blk_t1'], blk_hand: ['blk_t2'] },
    })

    const report = await applyReset(f.client, f.files, await planFor(f, { all: true }))

    expect(f.calls).toEqual(['task:blk_t1', 'service:blk_api', 'task:blk_t2', 'service:blk_hand'])
    expect(report.frames.map((frame) => frame.outcome.status)).toEqual(['deleted', 'deleted'])
    expect(resetSucceeded(report)).toBe(true)
  })

  it('counts a task the deployment says is already gone as deleted', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
      tasks: { blk_api: ['blk_t1'] },
      goneTask: ['blk_t1'],
    })

    const report = await applyReset(f.client, f.files, await planFor(f))

    expect(report.frames[0]?.deletedTasks).toEqual(['blk_t1'])
    expect(report.frames[0]?.failedTasks).toEqual([])
    expect(resetSucceeded(report)).toBe(true)
  })

  it('carries on past a task it cannot delete, and fails the reset', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
      tasks: { blk_api: ['blk_t1', 'blk_t2'] },
      failTask: ['blk_t1'],
      refuseService: { blk_api: 'service_has_unfinished_tasks' },
    })

    const report = await applyReset(f.client, f.files, await planFor(f))

    expect(f.calls).toEqual(['task:blk_t1', 'task:blk_t2', 'service:blk_api'])
    expect(report.frames[0]?.failedTasks[0]?.taskId).toBe('blk_t1')
    expect(report.frames[0]?.outcome).toMatchObject({
      status: 'refused',
      reason: 'service_has_unfinished_tasks',
    })
    expect(resetSucceeded(report)).toBe(false)
  })

  it('reads a frame that 404s as already gone rather than as a refusal', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
    })
    const plan = await planFor(f)
    const racing: ResetClient = {
      ...f.client,
      deleteService: async () => {
        throw notFound('Service')
      },
    }

    const report = await applyReset(racing, f.files, plan)

    expect(report.frames[0]?.outcome).toEqual({ status: 'absent' })
    expect(resetSucceeded(report)).toBe(true)
  })

  it('KEEPS a ledger naming a live frame this reset never targeted', async () => {
    // The two-service pass whose configuration moved on: the `.env` now points at one repository, so
    // the plan takes that frame and the OTHER one stays on the board. Removing the ledger anyway
    // strands it with nothing naming its owner, which is the dead end the refusals avoid by naming a
    // run id: the frame earns `target-repos` again and the id that would resume it is in the deleted
    // file.
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [
        { serviceId: 'blk_api', title: TITLES.backend },
        { serviceId: 'blk_web', title: 'old-prefix Catalog Web' },
      ],
    })
    const plan = await planFor(f, {
      passes: [ledger('p1', { backend: 'blk_api', frontend: 'blk_web' })],
    })

    expect(plan.passes[0]?.unreclaimed).toEqual(['blk_web'])
    const report = await applyReset(f.client, f.files, plan)
    expect(f.removed).toEqual([])
    expect(report.passes[0]?.kept).toContain('blk_web')
    // The frame it DID target still went: keeping the ledger is not a reason to leave the board alone.
    expect(report.frames[0]?.outcome).toEqual({ status: 'deleted' })
  })

  it('clears both when the pass is NAMED, since naming one widens the plan to its whole ledger', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [
        { serviceId: 'blk_api', title: TITLES.backend },
        { serviceId: 'blk_web', title: 'old-prefix Catalog Web' },
      ],
    })
    const plan = await planFor(f, {
      namedRunId: 'p1',
      passes: [ledger('p1', { backend: 'blk_api', frontend: 'blk_web' })],
    })

    expect(plan.passes[0]?.unreclaimed).toEqual([])
    const report = await applyReset(f.client, f.files, plan)
    expect(f.calls).toEqual(['service:blk_api', 'service:blk_web'])
    expect(report.passes[0]?.removed).toHaveLength(2)
  })

  it('KEEPS a ledger whose frame survived, because nothing else names that frame’s owner', async () => {
    // The failure this exists against: removed anyway, the surviving frame earns `target-repos`
    // again on the next attempt with no pass to name in the remedy, and the resume that would have
    // continued it is unreachable, since the id was in the file just deleted.
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
      tasks: { blk_api: ['blk_t1'] },
      refuseService: { blk_api: 'service_has_unfinished_tasks' },
    })
    const plan = await planFor(f, {
      passes: [ledger('p1', { backend: 'blk_api' })],
      latest: { runId: 'p1', path: '/state/latest.json' },
    })

    const report = await applyReset(f.client, f.files, plan)

    expect(f.removed).toEqual([])
    expect(report.passes[0]?.kept).toContain('blk_api')
    // …and the pointer stays with it, so `ACCEPTANCE_RUN_ID=latest` still resolves to a resumable pass.
    expect(report.pointerRemoved).toBe(false)
  })

  it('removes the files of a pass whose frames all went, and the pointer naming it', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
    })
    const plan = await planFor(f, {
      passes: [ledger('p1', { backend: 'blk_api' })],
      latest: { runId: 'p1', path: '/state/latest.json' },
    })

    const report = await applyReset(f.client, f.files, plan)

    expect(f.removed).toEqual(['/state/p1.json', '/state/p1.journal.jsonl', '/state/latest.json'])
    expect(report.passes[0]?.removed).toHaveLength(2)
    expect(report.pointerRemoved).toBe(true)
  })

  it('KEEPS every ledger while a repository it cannot free is still held, and FAILS', async () => {
    // The frame holding an unfreeable repository is one no read here can name (archived, or homed
    // elsewhere: the same row either way), so no ledger can be matched to it and the only safe
    // disposition is that one of them holds the run id that reaches it. And the reset FAILS: with
    // nothing refused and nothing deleted it would otherwise exit 0 under "Done. A fresh pass can
    // start" onto a board that earns the identical refusal on the next attempt.
    const f = fake({
      repos: [
        { name: 'catalog-api', serviceId: null, linkedElsewhere: true },
        { name: 'catalog-web', serviceId: 'blk_web' },
      ],
      services: [{ serviceId: 'blk_web', title: TITLES.frontend }],
    })
    const plan = await planFor(f, {
      passes: [ledger('p1', { frontend: 'blk_web' })],
      latest: { runId: 'p1', path: '/state/latest.json' },
    })

    const report = await applyReset(f.client, f.files, plan)

    expect(report.frames[0]?.outcome).toEqual({ status: 'deleted' })
    expect(f.removed).toEqual([])
    expect(report.passes[0]?.kept).toContain('acme/catalog-api')
    expect(report.pointerRemoved).toBe(false)
    expect(resetSucceeded(report)).toBe(false)
  })

  it('removes a DANGLING pointer under --all, which no pass can be stranded by', async () => {
    const f = fake({ repos: [{ name: 'catalog-api' }], services: [] })
    const plan = await planFor(f, {
      all: true,
      latest: { runId: null, path: '/state/latest.json' },
    })

    const report = await applyReset(f.client, f.files, plan)

    expect(f.removed).toEqual(['/state/latest.json'])
    expect(report.pointerRemoved).toBe(true)
  })

  it('reports only the files that were there, since a pass routinely has one', async () => {
    const f = fake({
      repos: [{ name: 'catalog-api', serviceId: 'blk_api' }],
      services: [{ serviceId: 'blk_api', title: TITLES.backend }],
      absentFiles: ['/state/p1.journal.jsonl'],
    })
    const plan = await planFor(f, { passes: [ledger('p1', { backend: 'blk_api' })] })

    const report = await applyReset(f.client, f.files, plan)

    expect(report.passes[0]?.removed).toEqual(['/state/p1.json'])
  })
})

describe('the rendered plan and report', () => {
  const plan: ResetPlan = {
    scope: 'configured',
    frames: [
      {
        serviceId: 'blk_api',
        title: TITLES.backend,
        reasons: [
          { kind: 'backs-repo', slug: 'acme/catalog-api' },
          { kind: 'named-by-pass', runId: 'p1' },
        ],
        tasks: [{ taskId: 'blk_t1', title: 'Ship the catalog', done: false }],
        absent: false,
      },
    ],
    // Empty in the base fixture: a stuck repository KEEPS every pass's files, which is its own
    // rendering, so a fixture carrying one could not also show the removal list.
    stuck: [],
    unlinked: [],
    passes: [
      {
        runId: 'p1',
        paths: ['/state/p1.json'],
        serviceIds: ['blk_api'],
        unreclaimed: [],
        issueUrl: null,
      },
    ],
    pointer: { runId: 'p1', path: '/state/latest.json' },
    leftovers: ['the repositories keep their content'],
  }

  it('names every frame, its reasons, its tasks and the files, before anything is deleted', () => {
    const text = formatResetPlan({
      ...plan,
      stuck: [{ slug: 'acme/catalog-web', steps: ['it is homed elsewhere'] }],
    })
    expect(text).toContain("blk_api 'cf-acc Catalog API'")
    expect(text).toContain("because it backs 'acme/catalog-api'")
    expect(text).toContain("because it is named by pass p1's ledger")
    expect(text).toContain('task blk_t1: Ship the catalog')
    // Both halves a reset cannot do are printed with the preview, not only with the outcome.
    expect(text).toContain('acme/catalog-web')
    expect(text).toContain('the repositories keep their content')
  })

  it('lists a pass under REMOVE or KEPT by the rule the apply will use, never both', () => {
    // The preview is this command's stated safety property, so listing files under "to remove"
    // that the apply then keeps misstates an outcome the plan has already computed. Everything the
    // retention rule keys on but a REFUSED frame is known here.
    const text = formatResetPlan(plan)
    expect(text).toContain('Local pass files to remove (1 pass(es))')
    expect(text).toContain('/state/p1.json')
    expect(text).toContain("The 'latest' pointer names p1, so it goes too")
    expect(text).not.toContain('Local pass files KEPT')

    const stranded = formatResetPlan({
      ...plan,
      passes: [{ ...(plan.passes[0] as (typeof plan.passes)[number]), unreclaimed: ['blk_web'] }],
    })
    expect(stranded).toContain('Local pass files KEPT (1 pass(es))')
    expect(stranded).toContain('blk_web is still on the board')
    expect(stranded).not.toContain('Local pass files to remove')
    // …and the pointer stays with the pass whose files stay, or `latest` outlives its ledger.
    expect(stranded).not.toContain('so it goes too')
  })

  it('says outright when there is nothing on the board to clear', () => {
    expect(formatResetPlan({ ...plan, frames: [], passes: [], pointer: null })).toContain(
      'No service frame on this board belongs to this configuration or the named pass',
    )
  })

  it('states the whole-board scope before the list, since the two render the same on one pass', () => {
    // A board holding exactly one pass produces an identical frame list either way, so the list is
    // not what an operator can grade a `--all --yes` on. The scope line is.
    const whole = formatResetPlan({ ...plan, scope: 'whole-board' })
    expect(whole).toContain('--all: the target is EVERY service frame this board lists')
    expect(whole.indexOf('--all:')).toBeLessThan(whole.indexOf('Service frames to delete'))
    expect(formatResetPlan(plan)).not.toContain('--all:')
  })

  it('answers an empty whole-board plan with what it actually read, not the narrow sentence', () => {
    // "No frame belongs to this configuration" would be true and misleading: under `--all` the
    // configuration is not what bounded the read, so the fact is that the board lists nothing.
    const text = formatResetPlan({
      ...plan,
      scope: 'whole-board',
      frames: [],
      passes: [],
      pointer: null,
    })
    expect(text).toContain('This board lists no service frame at all')
    expect(text).not.toContain('belongs to this configuration')
  })

  it('names a repository this workspace has not linked, so an empty plan is not read as a clean board', () => {
    // "Nothing on this board backs it" and "this read cannot see it" are different facts, and only
    // the first means a reset has nothing to do: an unlinked repository spoken for on ANOTHER board
    // reads identically here, and `target-repos` is what tells them apart.
    const text = formatResetPlan({
      ...plan,
      frames: [],
      passes: [],
      pointer: null,
      unlinked: ['acme/catalog-web'],
    })
    expect(text).toContain('Not linked to this workspace')
    expect(text).toContain('acme/catalog-web')
    expect(text).toContain('target-repos')
  })

  it('renders a refusal with its machine-readable reason, and repeats what it cannot reclaim', () => {
    const text = formatResetReport({
      frames: [
        {
          serviceId: 'blk_api',
          title: TITLES.backend,
          outcome: { status: 'refused', reason: 'service_has_unfinished_tasks', detail: 'nope' },
          deletedTasks: [],
          failedTasks: [{ taskId: 'blk_t1', detail: 'boom' }],
        },
      ],
      passes: [{ runId: 'p1', removed: [], kept: 'blk_api could not be deleted' }],
      pointerRemoved: false,
      stuck: [{ slug: 'acme/catalog-web', steps: ['it is homed elsewhere'] }],
      // Restated by the OUTCOME and not only by the preview: `--yes` is a separate invocation and
      // the one every printed remedy ends with, so a report that dropped this reads as a clean
      // board to the only person who ran it.
      unlinked: ['acme/catalog-mobile'],
      leftovers: plan.leftovers,
    })
    expect(text).toContain('REFUSED [service_has_unfinished_tasks]')
    expect(text).toContain('task blk_t1 could NOT be deleted: boom')
    expect(text).toContain('KEPT, because blk_api could not be deleted')
    expect(text).toContain('Not linked to this workspace')
    expect(text).toContain('acme/catalog-mobile')
    expect(text).toContain('the repositories keep their content')
  })
})

describe('parseResetArgs', () => {
  it('takes a pass id and the apply flag in either order', () => {
    expect(parseResetArgs(['--yes', '20260811151012'])).toEqual({
      ok: true,
      runId: '20260811151012',
      all: false,
      apply: true,
    })
    expect(parseResetArgs(['latest', '-y'])).toEqual({
      ok: true,
      runId: 'latest',
      all: false,
      apply: true,
    })
  })

  it('defaults to a PREVIEW, because the argument-less form must delete nothing', () => {
    expect(parseResetArgs([])).toEqual({ ok: true, runId: null, all: false, apply: false })
  })

  it('reads --all as the scope and never as an apply', () => {
    // The two flags are independent on purpose: `--all` alone is the preview of a whole-board clear,
    // which is the form an operator reads before deciding, and it must delete nothing on its own.
    expect(parseResetArgs(['--all'])).toEqual({ ok: true, runId: null, all: true, apply: false })
    expect(parseResetArgs(['--all', '--yes'])).toEqual({
      ok: true,
      runId: null,
      all: true,
      apply: true,
    })
  })

  it('refuses an unknown flag rather than reading it as a run id', () => {
    // The mistake worth refusing: a mistyped `--dry-run` read as a pass id would report on a pass
    // that does not exist, and the flag being reached for is the one that decides whether anything
    // is deleted at all.
    const parsed = parseResetArgs(['--dry-run'])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.problem).toContain("unknown option '--dry-run'")
  })

  it('refuses two pass ids, since a reset clears one named pass', () => {
    const parsed = parseResetArgs(['p1', 'p2'])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.problem).toContain('both name a pass')
  })
})
