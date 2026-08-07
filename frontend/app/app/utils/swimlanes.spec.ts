import { describe, expect, it } from 'vitest'
import type { Block, BlockStatus } from '~/types/domain'
import {
  classifyTask,
  LANE_BY_REASON,
  LANE_REASONS,
  selectDoneLaneTasks,
  TASK_LANES,
  type TaskLaneInput,
} from '~/utils/swimlanes'

// The lane a card sits in is a CLAIM, not a decoration: file a parked run under "In
// progress" and the human it is waiting on never scans the column it is in. So the cases
// worth pinning are the ones where two states would otherwise collapse into one lane — a
// failure vs a gate, a background reviewer vs a real question, a finished pipeline vs a
// live one — plus the two totality properties that stop a card vanishing entirely.

function input(overrides: Partial<TaskLaneInput> = {}): TaskLaneInput {
  return {
    status: 'ready',
    run: null,
    runFailed: false,
    parkIsBackground: false,
    pendingDecision: false,
    pendingApproval: false,
    hasUnmetDeps: false,
    ...overrides,
  }
}

function doneTask(id: string, completedAt: number | undefined): Block {
  return { id, title: id, status: 'done', level: 'task', completedAt } as Block
}

describe('classifyTask — totality', () => {
  it('gives every BlockStatus a lane, so a card can never fall out of the board', () => {
    // Derived from the status vocabulary rather than a hand-listed count: adding a status
    // must fail HERE (and in the Record the function reads) rather than silently produce a
    // task that renders in no column at all.
    const statuses: BlockStatus[] = [
      'planned',
      'ready',
      'in_progress',
      'blocked',
      'pr_ready',
      'done',
    ]
    for (const status of statuses) {
      const { lane } = classifyTask(input({ status }))
      expect(TASK_LANES, `status ${status}`).toContain(lane)
    }
  })

  it('reports a status this build does not know instead of dropping the card', () => {
    // The Record is total against the TYPE and partial against the DATABASE: a status
    // retired by a later build still sits on old rows. Reading one back must not hand
    // `undefined` to the lane lookup.
    const { lane, reason } = classifyTask(input({ status: 'archived_forever' as BlockStatus }))
    expect(reason).toBe('unclassified')
    expect(lane).toBe('needs_you')
  })

  it('assigns every reason a lane, and leaves no lane without a reason', () => {
    for (const reason of LANE_REASONS) {
      expect(TASK_LANES, `reason ${reason}`).toContain(LANE_BY_REASON[reason])
    }
    // The other direction: a lane no reason maps to would render as a permanently empty
    // column, which reads as "nothing is in this state" rather than "this is unreachable".
    const reached = new Set(LANE_REASONS.map((r) => LANE_BY_REASON[r]))
    expect([...TASK_LANES].filter((lane) => !reached.has(lane))).toEqual([])
  })
})

describe('classifyTask — precedence', () => {
  it('treats merged as terminal even when the run that merged it is gone', () => {
    // A retry prunes terminal runs, so a merged task routinely has no run to consult.
    expect(classifyTask(input({ status: 'done', run: null }))).toEqual({
      lane: 'done',
      reason: 'merged',
    })
  })

  it('ranks a failure above a park, because the two need unrelated actions', () => {
    // A failed run leaves the BLOCK on `blocked` exactly as a park does, so keying off the
    // block alone would show "Approval needed" on a run that crashed.
    const verdict = classifyTask(
      input({
        status: 'blocked',
        run: { status: 'blocked' },
        runFailed: true,
        pendingApproval: true,
      }),
    )
    expect(verdict).toEqual({ lane: 'needs_you', reason: 'failed' })
  })

  it('separates a spend pause from a failure', () => {
    // Nothing on the board renders this state today: a paused run reads as still working.
    // It needs a human (raise the budget) but it has not broken.
    expect(classifyTask(input({ status: 'in_progress', run: { status: 'paused' } }))).toEqual({
      lane: 'needs_you',
      reason: 'budget_paused',
    })
  })

  it('keeps a background reviewer IN FLIGHT rather than asking for an answer', () => {
    // An iterative reviewer mid-cycle parks the run with a pending approval while the
    // driver folds answers in. Nobody is waiting on a human, so `needs_you` would be a
    // request for input that does not exist.
    expect(
      classifyTask(
        input({
          status: 'blocked',
          run: { status: 'blocked' },
          parkIsBackground: true,
          pendingApproval: true,
        }),
      ),
    ).toEqual({ lane: 'in_progress', reason: 'background_review' })
  })

  it('names a decision before an approval when both are open', () => {
    const verdict = classifyTask(
      input({
        status: 'blocked',
        run: { status: 'blocked' },
        pendingDecision: true,
        pendingApproval: true,
      }),
    )
    expect(verdict.reason).toBe('decision')
  })

  it('files an unnameable park as a human wait, never as work in flight', () => {
    // The SPA models only decisions and approvals globally; a judge / human-test / fork /
    // follow-up / input-gate park is reachable only by drilling in. `run.status === 'blocked'`
    // is the canonical marker for all of them, so the lane is still right even though the
    // reason cannot be narrowed.
    expect(classifyTask(input({ status: 'blocked', run: { status: 'blocked' } }))).toEqual({
      lane: 'needs_you',
      reason: 'parked',
    })
  })

  it('distinguishes a finished pipeline with an open PR from a live one', () => {
    const finished = classifyTask(input({ status: 'pr_ready', run: { status: 'done' } }))
    expect(finished).toEqual({ lane: 'needs_you', reason: 'pr_awaiting_merge' })

    // Mid-run, `pr_ready` means the PR is open and CI + the merger are still to come.
    const live = classifyTask(input({ status: 'pr_ready', run: { status: 'running' } }))
    expect(live).toEqual({ lane: 'in_progress', reason: 'running' })
  })

  it('prefers a live run to a stale block status', () => {
    // The engine writes the block after the run advances, so the two disagree for one
    // round trip. The run is the fresher fact.
    expect(classifyTask(input({ status: 'blocked', run: { status: 'running' } }))).toEqual({
      lane: 'in_progress',
      reason: 'running',
    })
  })

  it('separates a runnable backlog task from one waiting on a dependency', () => {
    expect(classifyTask(input({ status: 'ready' })).reason).toBe('unstarted')
    const blocked = classifyTask(input({ status: 'ready', hasUnmetDeps: true }))
    // Same lane — it has not started either way — but a different reason, because "start
    // this" is offered for one and refused for the other.
    expect(blocked).toEqual({ lane: 'not_started', reason: 'dependencies' })
  })
})

describe('selectDoneLaneTasks', () => {
  const NOW = 1_000 * 86_400_000

  it('drops tasks completed outside the retention window and says how many', () => {
    const result = selectDoneLaneTasks(
      [
        doneTask('fresh', NOW - 86_400_000),
        doneTask('stale', NOW - 30 * 86_400_000),
        doneTask('ancient', NOW - 400 * 86_400_000),
      ],
      { maxItems: 50, retentionDays: 14 },
      NOW,
    )
    expect(result.shown.map((b) => b.id)).toEqual(['fresh'])
    expect(result.hiddenByAge).toBe(2)
    expect(result.hiddenByCap).toBe(0)
    expect(result.total).toBe(3)
  })

  it('accounts for the two caps separately', () => {
    // They mean different things to a reader: "there is older history" vs "there is more
    // from this same period". One merged count would answer neither.
    // `t<i>` completed i days ago, so a 3-day window keeps t0..t3 (the boundary is inclusive)
    // and drops t4/t5; the count cap of 2 then takes t2/t3 off the visible end.
    const tasks = Array.from({ length: 6 }, (_, i) => doneTask(`t${i}`, NOW - i * 86_400_000))
    const result = selectDoneLaneTasks(tasks, { maxItems: 2, retentionDays: 3 }, NOW)
    expect(result.shown.map((b) => b.id)).toEqual(['t0', 't1'])
    expect(result.hiddenByAge).toBe(2)
    expect(result.hiddenByCap).toBe(2)
    // The two accounts plus what is shown must cover every completed task exactly once, or
    // the lane's "N hidden" lines would quietly disagree with its total.
    expect(result.shown.length + result.hiddenByAge + result.hiddenByCap).toBe(result.total)
  })

  it('exempts an undated task from the age cap and reports that it did', () => {
    // Blocks written before `completedAt` existed have no honest age. Treating absent as
    // ancient would hide history on the strength of a timestamp nobody recorded.
    const result = selectDoneLaneTasks(
      [doneTask('dated', NOW - 400 * 86_400_000), doneTask('undated', undefined)],
      { maxItems: 50, retentionDays: 14 },
      NOW,
    )
    expect(result.shown.map((b) => b.id)).toEqual(['undated'])
    expect(result.hiddenByAge).toBe(1)
    expect(result.undatedShown).toBe(1)
  })

  it('still bounds undated tasks by the count cap, so the exemption cannot unbound the lane', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => doneTask(`u${i}`, undefined))
    const result = selectDoneLaneTasks(tasks, { maxItems: 2, retentionDays: 14 }, NOW)
    expect(result.shown).toHaveLength(2)
    expect(result.hiddenByCap).toBe(3)
  })

  it('sorts newest completion first and puts undated last', () => {
    const result = selectDoneLaneTasks(
      [
        doneTask('old', NOW - 3 * 86_400_000),
        doneTask('undated', undefined),
        doneTask('new', NOW - 86_400_000),
      ],
      { maxItems: 50, retentionDays: null },
      NOW,
    )
    expect(result.shown.map((b) => b.id)).toEqual(['new', 'old', 'undated'])
  })

  it('counts without rendering when the cap is zero', () => {
    const result = selectDoneLaneTasks(
      [doneTask('a', NOW)],
      { maxItems: 0, retentionDays: null },
      NOW,
    )
    expect(result.shown).toEqual([])
    expect(result.hiddenByCap).toBe(1)
    expect(result.total).toBe(1)
  })

  it('applies no age filter when retention is null', () => {
    const result = selectDoneLaneTasks(
      [doneTask('ancient', NOW - 5_000 * 86_400_000)],
      { maxItems: 50, retentionDays: null },
      NOW,
    )
    expect(result.shown.map((b) => b.id)).toEqual(['ancient'])
    expect(result.hiddenByAge).toBe(0)
  })
})
