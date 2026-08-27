import { describe, expect, it } from 'vitest'
import { CatFactoryNotFoundError, CatFactoryValidationError } from '@cat-factory/sdk'
import {
  applyReset,
  formatResetPlan,
  formatResetReport,
  parseResetArgs,
  planReset,
  type ResetClient,
  type ResetInput,
  type ResetPassOnDisk,
  type ResetPlan,
  type ResetTargeting,
  resetSucceeded,
} from './reset.js'

// What is pinned here is the part of a reset that cannot be checked by running one: this deletes real
// service frames and real run history, so the interesting properties are the four rules the module
// header names. The ORDER of the writes (tasks before their frame, which is what stops the frame
// delete refusing), the two ways a reset must refuse to make things worse (a ledger removed while its
// frame survives, and a `latest` pointer left naming a deleted one), and the agreement between the
// preview and the apply about which files go.
//
// What a SUITE decides is a stub here on purpose: the targeting answers whatever a case needs, and
// what those questions ARE is pinned by the suite that asks them
// (`backend/internal/acceptance/test/reset.test.ts`).

/** A ledger fact type standing in for a suite's own: the service ids one pass created. */
type Facts = { services: readonly string[] }

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
  return {
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
function ledger(runId: string, ...services: string[]): ResetPassOnDisk<Facts> {
  return {
    runId,
    ledgerPath: `/state/${runId}.json`,
    journalPath: `/state/${runId}.journal.jsonl`,
    facts: { services },
  }
}

function input(
  overrides: Partial<ResetInput<Facts>> & { targeting?: ResetTargeting } = {},
): ResetInput<Facts> {
  const { targeting, ...rest } = overrides
  return {
    namedRunId: null,
    all: false,
    passes: [],
    // No pointer FILE, which is a different state from one naming nothing: see `readLatestPointer`.
    latest: null,
    target: () => targeting ?? { frames: [] },
    ledgerServiceIds: (facts) => facts.services,
    leftovers: () => ['something this suite cannot reclaim'],
    ...rest,
  }
}

describe('planReset', () => {
  it('states every reason one frame is in the plan, rather than the first that matched', async () => {
    // A frame reachable by two of a suite's questions AND by `--all` states all three: the reasons
    // are what an operator grades the plan on, and the first match is rarely the interesting one.
    const f = fake({ services: [{ serviceId: 'blk_api', title: 'Catalog API' }] })

    const plan = await planReset(
      f.client,
      input({
        all: true,
        namedRunId: 'p1',
        passes: [ledger('p1', 'blk_api')],
        targeting: {
          frames: [
            { serviceId: 'blk_api', because: "backs 'acme/catalog-api'" },
            { serviceId: 'blk_api', because: "holds the title 'Catalog API'" },
          ],
        },
      }),
    )

    expect(plan.frames).toHaveLength(1)
    expect(plan.frames[0]?.reasons).toEqual([
      { kind: 'targeted', because: "backs 'acme/catalog-api'" },
      { kind: 'targeted', because: "holds the title 'Catalog API'" },
      { kind: 'named-by-pass', runId: 'p1' },
      { kind: 'whole-board' },
    ])
  })

  it('reads the tasks under a planned frame, in the order the board lists them', async () => {
    const f = fake({
      services: [{ serviceId: 'blk_api', title: 'Catalog API' }],
      tasks: { blk_api: ['blk_t1', 'blk_t2'] },
    })

    const plan = await planReset(
      f.client,
      input({ targeting: { frames: [{ serviceId: 'blk_api', because: 'is targeted' }] } }),
    )

    expect(plan.frames[0]?.tasks.map((task) => task.taskId)).toEqual(['blk_t1', 'blk_t2'])
    expect(plan.frames[0]?.absent).toBe(false)
  })

  it('reports a frame the board no longer lists as absent, and asks it for no tasks', async () => {
    // Asking would turn "already gone" into a 404 the plan cannot describe.
    const f = fake({ services: [] })

    const plan = await planReset(
      f.client,
      input({
        namedRunId: 'p1',
        passes: [ledger('p1', 'blk_gone')],
        targeting: { frames: [] },
      }),
    )

    expect(plan.frames[0]).toMatchObject({ serviceId: 'blk_gone', title: null, absent: true })
    expect(plan.frames[0]?.tasks).toEqual([])
  })

  it('widens to what a NAMED pass holds, including a frame no question targets', async () => {
    const f = fake({ services: [{ serviceId: 'blk_stale', title: 'Older prefix' }] })

    const plan = await planReset(
      f.client,
      input({ namedRunId: 'p1', passes: [ledger('p1', 'blk_stale')], targeting: { frames: [] } }),
    )

    expect(plan.frames.map((frame) => frame.serviceId)).toEqual(['blk_stale'])
    expect(plan.frames[0]?.reasons).toEqual([{ kind: 'named-by-pass', runId: 'p1' }])
  })

  it('leaves an unrelated pass’s files alone, since they are how somebody else resumes', async () => {
    const f = fake({ services: [{ serviceId: 'blk_api', title: 'Catalog API' }] })

    const plan = await planReset(
      f.client,
      input({
        passes: [ledger('mine', 'blk_api'), ledger('theirs', 'blk_other')],
        targeting: { frames: [{ serviceId: 'blk_api', because: 'is targeted' }] },
      }),
    )

    expect(plan.passes.map((pass) => pass.runId)).toEqual(['mine'])
  })

  it('takes every pass on disk under --all, including one whose ledger names nothing', async () => {
    // A refused attempt has a journal and no readable ledger, so it names no frame and no other
    // branch can reach it. Left behind on a board with no frames at all, its run id is one a status
    // report still lists and `latest` may still resolve to.
    const f = fake({ services: [] })
    const refusedAttempt: ResetPassOnDisk<Facts> = {
      runId: 'p0',
      ledgerPath: '/state/p0.json',
      journalPath: '/state/p0.journal.jsonl',
      facts: null,
    }

    const narrow = await planReset(f.client, input({ passes: [refusedAttempt] }))
    const whole = await planReset(f.client, input({ all: true, passes: [refusedAttempt] }))

    expect(narrow.passes).toEqual([])
    expect(whole.passes.map((pass) => pass.runId)).toEqual(['p0'])
    const report = await applyReset(f.client, f.files, whole)
    expect(report.passes[0]?.removed).toHaveLength(2)
  })

  it('names the pointer only when it names a pass in the plan', async () => {
    const f = fake({ services: [{ serviceId: 'blk_api', title: 'Catalog API' }] })
    const passes = [ledger('mine', 'blk_api'), ledger('theirs', 'blk_other')]
    const targeting = { frames: [{ serviceId: 'blk_api', because: 'is targeted' }] }

    const mine = await planReset(
      f.client,
      input({ passes, targeting, latest: { runId: 'mine', path: '/state/latest.json' } }),
    )
    const theirs = await planReset(
      f.client,
      input({ passes, targeting, latest: { runId: 'theirs', path: '/state/latest.json' } }),
    )

    expect(mine.pointer).toEqual({ runId: 'mine', path: '/state/latest.json' })
    expect(theirs.pointer).toBeNull()
  })

  it('takes a DANGLING pointer under --all, which is the scope that clears the directory', async () => {
    // A pointer naming nothing outlives every ledger in the directory, and `latest` then resolves a
    // resume onto a state directory holding none: a fresh pass wearing a finished pass's run id.
    const f = fake({ services: [] })
    const dangling = { runId: null, path: '/state/latest.json' }

    const whole = await planReset(f.client, input({ all: true, latest: dangling }))
    const narrow = await planReset(f.client, input({ latest: dangling }))

    expect(whole.pointer).toEqual(dangling)
    expect(narrow.pointer).toBeNull()
  })

  it('names no pointer when the state directory holds no pointer FILE', async () => {
    // Absent is not the same as naming nothing: announcing the removal of a file that was never
    // there is what collapsing the two would do.
    const f = fake({ services: [] })
    expect((await planReset(f.client, input({ all: true, latest: null }))).pointer).toBeNull()
  })

  it('carries the suite’s blockers, notes and leftovers onto the plan', async () => {
    const f = fake({ services: [] })

    const plan = await planReset(
      f.client,
      input({
        targeting: {
          frames: [],
          blockers: [{ subject: 'acme/catalog-api', steps: ['it is homed elsewhere'] }],
          notes: ['this read could not see acme/catalog-web'],
        },
        leftovers: () => ['the repositories keep their content'],
      }),
    )

    expect(plan.blockers).toEqual([
      { subject: 'acme/catalog-api', steps: ['it is homed elsewhere'] },
    ])
    expect(plan.notes).toEqual(['this read could not see acme/catalog-web'])
    expect(plan.leftovers).toEqual(['the repositories keep their content'])
  })

  it('tells the leftovers what the plan came to, so a ledger’s facts outlive the file', async () => {
    // Deleting the ledger is what makes its facts unrecoverable, so the plan is the last moment
    // anything knows what was in it.
    const f = fake({ services: [{ serviceId: 'blk_api', title: 'Catalog API' }] })
    const seen: string[] = []

    await planReset(
      f.client,
      input({
        passes: [ledger('p1', 'blk_api')],
        targeting: { frames: [{ serviceId: 'blk_api', because: 'is targeted' }] },
        leftovers: (context) => {
          seen.push(
            ...context.frames.map((frame) => frame.serviceId),
            ...context.passes.flatMap((pass) => pass.facts?.services ?? []),
          )
          return []
        },
      }),
    )

    expect(seen).toEqual(['blk_api', 'blk_api'])
  })
})

describe('applyReset', () => {
  it('deletes every task BEFORE its frame, which is what stops the frame delete refusing', async () => {
    const f = fake({
      services: [{ serviceId: 'blk_api', title: 'Catalog API' }],
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
    // deployment a whole-board read for something the one frame delete does anyway.
    const f = fake({
      services: [{ serviceId: 'blk_api', title: 'Catalog API' }],
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
    // Per-frame sequencing is what the frame delete's refusal needs: a frame whose own tasks are
    // gone can be deleted while another frame's are still there. Batching every task first would
    // leave a failure mid-flight having emptied frames nothing then removed.
    const f = fake({
      services: [
        { serviceId: 'blk_api', title: 'Catalog API' },
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
      services: [{ serviceId: 'blk_api', title: 'Catalog API' }],
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
      services: [{ serviceId: 'blk_api', title: 'Catalog API' }],
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
    const f = fake({ services: [{ serviceId: 'blk_api', title: 'Catalog API' }] })
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
    // The pass whose configuration moved on: the plan takes one of its frames and the OTHER stays on
    // the board. Removing the ledger anyway strands that frame with nothing naming its owner, and
    // the id that would resume it was in the file just deleted.
    const f = fake({
      services: [
        { serviceId: 'blk_api', title: 'Catalog API' },
        { serviceId: 'blk_web', title: 'old-prefix Catalog Web' },
      ],
    })
    const plan = await planFor(f, { passes: [ledger('p1', 'blk_api', 'blk_web')] })

    expect(plan.passes[0]?.unreclaimed).toEqual(['blk_web'])
    const report = await applyReset(f.client, f.files, plan)

    expect(f.removed).toEqual([])
    expect(report.passes[0]?.kept).toContain('blk_web')
    // The frame it DID target still went: keeping the ledger is no reason to leave the board alone.
    expect(report.frames[0]?.outcome).toEqual({ status: 'deleted' })
  })

  it('clears both when the pass is NAMED, since naming one widens the plan to its whole ledger', async () => {
    const f = fake({
      services: [
        { serviceId: 'blk_api', title: 'Catalog API' },
        { serviceId: 'blk_web', title: 'old-prefix Catalog Web' },
      ],
    })
    const plan = await planFor(f, {
      namedRunId: 'p1',
      passes: [ledger('p1', 'blk_api', 'blk_web')],
    })

    expect(plan.passes[0]?.unreclaimed).toEqual([])
    const report = await applyReset(f.client, f.files, plan)

    expect(f.calls).toEqual(['service:blk_api', 'service:blk_web'])
    expect(report.passes[0]?.removed).toHaveLength(2)
  })

  it('KEEPS a ledger whose frame survived, because nothing else names that frame’s owner', async () => {
    // The failure this exists against: removed anyway, the surviving frame earns the same refusal on
    // the next attempt with no pass to name in the remedy, and the resume that would have continued
    // it is unreachable, since the id was in the file just deleted.
    const f = fake({
      services: [{ serviceId: 'blk_api', title: 'Catalog API' }],
      tasks: { blk_api: ['blk_t1'] },
      refuseService: { blk_api: 'service_has_unfinished_tasks' },
    })
    const plan = await planFor(f, {
      passes: [ledger('p1', 'blk_api')],
      latest: { runId: 'p1', path: '/state/latest.json' },
    })

    const report = await applyReset(f.client, f.files, plan)

    expect(f.removed).toEqual([])
    expect(report.passes[0]?.kept).toContain('blk_api')
    // …and the pointer stays with it, so a `latest` resume still resolves to a resumable pass.
    expect(report.pointerRemoved).toBe(false)
  })

  it('removes the files of a pass whose frames all went, and the pointer naming it', async () => {
    const f = fake({ services: [{ serviceId: 'blk_api', title: 'Catalog API' }] })
    const plan = await planFor(f, {
      passes: [ledger('p1', 'blk_api')],
      latest: { runId: 'p1', path: '/state/latest.json' },
    })

    const report = await applyReset(f.client, f.files, plan)

    expect(f.removed).toEqual(['/state/p1.json', '/state/p1.journal.jsonl', '/state/latest.json'])
    expect(report.passes[0]?.removed).toHaveLength(2)
    expect(report.pointerRemoved).toBe(true)
  })

  it('KEEPS every ledger while a blocker is still held, and FAILS', async () => {
    // Whatever holds a blocker is a frame no read here can name, so no ledger can be matched to it
    // and the only safe disposition is that one of them holds the run id that reaches it. And the
    // reset FAILS: with nothing refused and nothing left undeleted it would otherwise exit 0 under
    // "done" onto a board that earns the identical refusal on the next attempt.
    const f = fake({ services: [{ serviceId: 'blk_web', title: 'Catalog Web' }] })
    const plan = await planFor(f, {
      passes: [ledger('p1', 'blk_web')],
      latest: { runId: 'p1', path: '/state/latest.json' },
      targeting: {
        frames: [{ serviceId: 'blk_web', because: 'is targeted' }],
        blockers: [{ subject: 'acme/catalog-api', steps: ['it is homed elsewhere'] }],
      },
    })

    const report = await applyReset(f.client, f.files, plan)

    expect(report.frames[0]?.outcome).toEqual({ status: 'deleted' })
    expect(f.removed).toEqual([])
    expect(report.passes[0]?.kept).toContain('acme/catalog-api')
    expect(report.pointerRemoved).toBe(false)
    expect(resetSucceeded(report)).toBe(false)
  })

  it('removes a DANGLING pointer under --all, which no pass can be stranded by', async () => {
    const f = fake({ services: [] })
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
      services: [{ serviceId: 'blk_api', title: 'Catalog API' }],
      absentFiles: ['/state/p1.journal.jsonl'],
    })
    const plan = await planFor(f, { passes: [ledger('p1', 'blk_api')] })

    const report = await applyReset(f.client, f.files, plan)

    expect(report.passes[0]?.removed).toEqual(['/state/p1.json'])
  })
})

/** The default target for the apply cases: whatever `blk_api` and `blk_hand` the board holds. */
async function planFor(
  f: Fake,
  over: Partial<ResetInput<Facts>> & { targeting?: ResetTargeting } = {},
): Promise<ResetPlan<Facts>> {
  return planReset(
    f.client,
    input({
      targeting: { frames: [{ serviceId: 'blk_api', because: 'is targeted' }] },
      ...over,
    }),
  )
}

describe('the rendered plan and report', () => {
  const plan: ResetPlan<Facts> = {
    scope: 'configured',
    frames: [
      {
        serviceId: 'blk_api',
        title: 'Catalog API',
        reasons: [
          { kind: 'targeted', because: "backs 'acme/catalog-api'" },
          { kind: 'named-by-pass', runId: 'p1' },
        ],
        tasks: [{ taskId: 'blk_t1', title: 'Ship the catalog', done: false }],
        absent: false,
      },
    ],
    // Empty in the base fixture: a blocker KEEPS every pass's files, which is its own rendering, so
    // a fixture carrying one could not also show the removal list.
    blockers: [],
    notes: [],
    passes: [
      {
        runId: 'p1',
        paths: ['/state/p1.json'],
        serviceIds: ['blk_api'],
        unreclaimed: [],
        facts: null,
      },
    ],
    pointer: { runId: 'p1', path: '/state/latest.json' },
    leftovers: ['the repositories keep their content'],
  }

  it('names every frame, its reasons, its tasks and the files, before anything is deleted', () => {
    const text = formatResetPlan({
      ...plan,
      blockers: [{ subject: 'acme/catalog-web', steps: ['it is homed elsewhere'] }],
    })
    expect(text).toContain("blk_api 'Catalog API'")
    expect(text).toContain("because it backs 'acme/catalog-api'")
    expect(text).toContain("because it is named by pass p1's ledger")
    expect(text).toContain('task blk_t1: Ship the catalog')
    // Both halves a reset cannot do are printed with the preview, not only with the outcome.
    expect(text).toContain('acme/catalog-web')
    expect(text).toContain('it is homed elsewhere')
    expect(text).toContain('the repositories keep their content')
  })

  it('lists a pass under REMOVE or KEPT by the rule the apply will use, never both', () => {
    // The preview is this command's stated safety property, so listing files under "to remove" that
    // the apply then keeps misstates an outcome the plan has already computed. Everything the
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

  it('prints a suite’s notes, so an empty plan is not read as a clean board', () => {
    const text = formatResetPlan({
      ...plan,
      frames: [],
      passes: [],
      pointer: null,
      notes: ['this read cannot say what backs acme/catalog-web'],
    })
    expect(text).toContain('this read cannot say what backs acme/catalog-web')
  })

  it('states an EMPTY leftovers list rather than rendering an empty section', () => {
    // A header with nothing under it reads exactly like a reset that reclaimed everything, which is
    // the one reading this paragraph exists to prevent.
    const text = formatResetPlan({ ...plan, leftovers: [] })
    expect(text).toContain('this suite names nothing')
  })

  it('renders a refusal with its machine-readable reason, and repeats what it cannot reclaim', () => {
    const text = formatResetReport({
      frames: [
        {
          serviceId: 'blk_api',
          title: 'Catalog API',
          outcome: { status: 'refused', reason: 'service_has_unfinished_tasks', detail: 'nope' },
          deletedTasks: [],
          failedTasks: [{ taskId: 'blk_t1', detail: 'boom' }],
        },
      ],
      passes: [{ runId: 'p1', removed: [], kept: 'blk_api could not be deleted' }],
      pointerRemoved: false,
      blockers: [{ subject: 'acme/catalog-web', steps: ['it is homed elsewhere'] }],
      // Restated by the OUTCOME and not only by the preview: `--yes` is a separate invocation and
      // the one every printed remedy ends with, so a report that dropped this reads as a clean board
      // to the only person who ran it.
      notes: ['this read cannot say what backs acme/catalog-mobile'],
      leftovers: plan.leftovers,
    })
    expect(text).toContain('REFUSED [service_has_unfinished_tasks]')
    expect(text).toContain('task blk_t1 could NOT be deleted: boom')
    expect(text).toContain('KEPT, because blk_api could not be deleted')
    expect(text).toContain('acme/catalog-mobile')
    expect(text).toContain('acme/catalog-web')
    expect(text).toContain('the repositories keep their content')
  })
})

describe('parseResetArgs', () => {
  const USAGE = 'my-reset [runId|latest] [--all] [--purge-repos] [--yes]'
  const options = { usage: USAGE, flags: ['--purge-repos'] }

  it('takes a pass id and the apply flag in either order', () => {
    expect(parseResetArgs(['--yes', '20260811151012'], options)).toEqual({
      ok: true,
      runId: '20260811151012',
      all: false,
      apply: true,
      flags: new Set(),
    })
    expect(parseResetArgs(['latest', '-y'], options)).toEqual({
      ok: true,
      runId: 'latest',
      all: false,
      apply: true,
      flags: new Set(),
    })
  })

  it('defaults to a PREVIEW, because the argument-less form must delete nothing', () => {
    expect(parseResetArgs([], options)).toEqual({
      ok: true,
      runId: null,
      all: false,
      apply: false,
      flags: new Set(),
    })
  })

  it('reads --all as the scope and never as an apply', () => {
    // The two flags are independent on purpose: `--all` alone is the preview of a whole-board clear,
    // which is the form an operator reads before deciding, and it must delete nothing on its own.
    expect(parseResetArgs(['--all'], options)).toMatchObject({ all: true, apply: false })
    expect(parseResetArgs(['--all', '--yes'], options)).toMatchObject({ all: true, apply: true })
  })

  it('hands a suite’s own flag back un-interpreted, implying neither --all nor an apply', () => {
    // A flag the kit does not act on is one it may not guess the meaning of, and a suite's axis is
    // its own: `--purge-repos` says whether to reclaim a provider side, which is not how much of the
    // board to clear.
    expect(parseResetArgs(['--purge-repos'], options)).toEqual({
      ok: true,
      runId: null,
      all: false,
      apply: false,
      flags: new Set(['--purge-repos']),
    })
    expect(parseResetArgs(['--all', '--purge-repos', '--yes'], options)).toEqual({
      ok: true,
      runId: null,
      all: true,
      apply: true,
      flags: new Set(['--purge-repos']),
    })
  })

  it('refuses a flag no suite declared rather than reading it as a run id', () => {
    // The mistake worth refusing: a mistyped `--dry-run` read as a pass id would report on a pass
    // that does not exist, and the flag being reached for is the one that decides whether anything
    // is deleted at all. A suite flag that was NOT declared lands here too, which is what stops a
    // renamed flag being silently ignored.
    const parsed = parseResetArgs(['--dry-run'], options)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.problem).toContain("unknown option '--dry-run'")
      expect(parsed.problem).toContain(USAGE)
    }
    expect(parseResetArgs(['--purge-repos'], { usage: USAGE }).ok).toBe(false)
  })

  it('refuses two pass ids, since a reset clears one named pass', () => {
    const parsed = parseResetArgs(['p1', 'p2'], options)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.problem).toContain('both name a pass')
  })
})
