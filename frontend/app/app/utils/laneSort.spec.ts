import { describe, expect, it } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '~/types/domain'
import {
  groupLaneTasks,
  LANE_SORT_KEYS,
  runActivityAt,
  runWaitingSince,
  sortLaneTasks,
  type LaneTaskEntry,
} from '~/utils/laneSort'

// Two invariants carry the ordering, and both are about NOT inventing facts. An unknown
// timestamp must never rank as an extreme (a run that reported no activity is not stale and
// not fresh), and every comparator must be total, because these re-run on every live board
// push and an unresolved tie lets cards trade places for no visible reason.

function entry(overrides: Partial<LaneTaskEntry> = {}): LaneTaskEntry {
  return {
    task: { id: 'blk', title: 'Task', status: 'ready', level: 'task' } as Block,
    reason: 'unstarted',
    order: 0,
    activityAt: null,
    waitingSince: null,
    moduleName: null,
    initiativeName: null,
    epicName: null,
    ...overrides,
  }
}

function task(overrides: Partial<Block> = {}): Block {
  return { id: 'blk', title: 'Task', status: 'ready', level: 'task', ...overrides } as Block
}

function step(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return { agentKind: 'coder', state: 'done', progress: 1, ...overrides } as PipelineStep
}

function run(steps: PipelineStep[], overrides: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return { id: 'exe', blockId: 'blk', status: 'running', steps, ...overrides } as ExecutionInstance
}

describe('runActivityAt', () => {
  it('prefers the harness heartbeat, the truthful signal where it exists', () => {
    expect(runActivityAt(run([step({ startedAt: 100, lastActivityAt: 500 })]))).toBe(500)
  })

  it('falls back to a start stamp, then the run creation, then unknown', () => {
    // `lastActivityAt` is only stamped on CONTAINER steps by a heartbeat-capable image, so
    // it is legitimately absent for inline steps and older harnesses.
    expect(runActivityAt(run([step({ startedAt: 100 })]))).toBe(100)
    expect(runActivityAt(run([step()], { createdAt: 42 }))).toBe(42)
    expect(runActivityAt(run([step()]))).toBeNull()
    expect(runActivityAt(null)).toBeNull()
  })

  it('takes the LATEST signal across steps, not the first', () => {
    expect(runActivityAt(run([step({ lastActivityAt: 100 }), step({ lastActivityAt: 900 })]))).toBe(
      900,
    )
  })
})

describe('runWaitingSince', () => {
  it("reads the engine's own park clock", () => {
    expect(runWaitingSince(run([step({ pausedAt: 700 })]))).toBe(700)
  })

  it('takes the EARLIEST park, so the wait is measured from when it started', () => {
    expect(runWaitingSince(run([step({ pausedAt: 700 }), step({ pausedAt: 300 })]))).toBe(300)
  })

  it('never substitutes how long the run has been ALIVE for how long it has WAITED', () => {
    // A run three days old that parked a minute ago has waited a minute. Falling back to
    // the run's start would sort a busy run to the top of the review queue.
    expect(runWaitingSince(run([step()], { createdAt: 1 }))).toBeNull()
  })

  it('accepts the notification-derived wait as an independent second source', () => {
    // Not every park surface stamps `pausedAt`; `collectReviewDebt` derives the same fact
    // from the earliest open review-wait card.
    expect(runWaitingSince(run([step()]), 250)).toBe(250)
    // …but the engine's own clock wins when both are present.
    expect(runWaitingSince(run([step({ pausedAt: 700 })]), 250)).toBe(700)
  })
})

describe('sortLaneTasks — unknown values', () => {
  it('ranks an unknown timestamp LAST in both directions', () => {
    const known = entry({ order: 1, activityAt: 500 })
    const unknown = entry({ order: 0, activityAt: null })

    // Oldest-first would put `null` first if it were read as 0, and newest-first would put
    // it first if it were read as Infinity. Neither is a fact anybody recorded.
    expect(sortLaneTasks([unknown, known], 'oldest_activity', 'in_progress')).toEqual([
      known,
      unknown,
    ])
    expect(sortLaneTasks([unknown, known], 'newest_activity', 'in_progress')).toEqual([
      known,
      unknown,
    ])
  })

  it('does not read a missing severity as `low`', () => {
    const critical = entry({ order: 1, task: task({ taskTypeFields: { severity: 'critical' } }) })
    const none = entry({ order: 0, task: task() })
    expect(sortLaneTasks([none, critical], 'severity_desc', 'needs_you')).toEqual([critical, none])
  })

  it('does not read a missing estimate as zero impact', () => {
    // `estimate` is absent until a `task-estimator` step has run, which is most tasks.
    const rated = entry({
      order: 1,
      task: task({
        estimate: { complexity: 0.2, risk: 0.2, impact: 0.9, rationale: '', createdAt: 1 },
      }),
    })
    const unrated = entry({ order: 0, task: task() })
    expect(sortLaneTasks([unrated, rated], 'impact_desc', 'not_started')).toEqual([rated, unrated])
  })
})

describe('sortLaneTasks — determinism', () => {
  it('resolves every tie on board order, for every sort key', () => {
    // Live pushes re-run these constantly; an unresolved tie reads as the lane shuffling
    // itself. Asserted over the whole key list so a new key cannot skip the tiebreak.
    const a = entry({ order: 0, task: task({ id: 'a', title: 'Same' }) })
    const b = entry({ order: 1, task: task({ id: 'b', title: 'Same' }) })
    for (const key of LANE_SORT_KEYS) {
      const ordered = sortLaneTasks([b, a], key, 'not_started')
      expect(
        ordered.map((e) => e.task.id),
        `key ${key}`,
      ).toEqual(['a', 'b'])
    }
  })

  it('does not mutate its input', () => {
    const entries = [entry({ order: 1 }), entry({ order: 0 })]
    const snapshot = [...entries]
    sortLaneTasks(entries, 'smart', 'not_started')
    expect(entries).toEqual(snapshot)
  })
})

describe('sortLaneTasks — the per-lane smart order', () => {
  it('sinks a dependency-blocked task below one that can start now', () => {
    const blocked = entry({ order: 0, reason: 'dependencies' })
    const ready = entry({ order: 1, reason: 'unstarted' })
    expect(sortLaneTasks([blocked, ready], 'smart', 'not_started')).toEqual([ready, blocked])
  })

  it('leads the in-progress lane with the QUIETEST run', () => {
    // A healthy run needs nothing; the reason to scan this column is to find the one that
    // stopped making noise.
    const quiet = entry({ order: 1, reason: 'running', activityAt: 100 })
    const busy = entry({ order: 0, reason: 'running', activityAt: 900 })
    expect(sortLaneTasks([busy, quiet], 'smart', 'in_progress')).toEqual([quiet, busy])
  })

  it('leads the needs-you lane with what is BROKEN, then the longest wait', () => {
    // A failure raises no review-wait card and stamps no park clock, so a pure wait-time
    // order files it behind gates that are merely patient.
    const failed = entry({ order: 2, reason: 'failed', waitingSince: null })
    const oldGate = entry({ order: 1, reason: 'approval', waitingSince: 100 })
    const newGate = entry({ order: 0, reason: 'approval', waitingSince: 900 })
    expect(sortLaneTasks([newGate, oldGate, failed], 'smart', 'needs_you')).toEqual([
      failed,
      oldGate,
      newGate,
    ])
  })

  it('leads the done lane with the most recent completion', () => {
    const older = entry({ order: 0, task: task({ completedAt: 100 }) })
    const newer = entry({ order: 1, task: task({ completedAt: 900 }) })
    expect(sortLaneTasks([older, newer], 'smart', 'done')).toEqual([newer, older])
  })
})

describe('groupLaneTasks', () => {
  it('keeps everything in one unlabelled group when grouping is off', () => {
    const entries = [entry({ order: 0 }), entry({ order: 1 })]
    expect(groupLaneTasks(entries, 'none')).toEqual([{ id: null, label: null, entries }])
  })

  it('orders groups by where their first member appears, preserving the sort', () => {
    // A group appearing out of sort order would silently override the sort key the reader
    // just chose.
    const groups = groupLaneTasks(
      [
        entry({ order: 0, moduleName: 'invoicing' }),
        entry({ order: 1, moduleName: 'billing' }),
        entry({ order: 2, moduleName: 'invoicing' }),
      ],
      'module',
    )
    expect(groups.map((g) => g.label)).toEqual(['invoicing', 'billing'])
    expect(groups[0]!.entries.map((e) => e.order)).toEqual([0, 2])
  })

  it('forces the catch-all group last however early its first member sorts', () => {
    // "Everything else" reading above a named group inverts the hierarchy the grouping states.
    const groups = groupLaneTasks(
      [entry({ order: 0, moduleName: null }), entry({ order: 1, moduleName: 'billing' })],
      'module',
    )
    expect(groups.map((g) => g.label)).toEqual(['billing', null])
  })

  it('carries a module BLOCK id onto its header so the header can be a drop target', () => {
    const groups = groupLaneTasks(
      [entry({ moduleName: 'billing' }), entry({ order: 1, moduleName: 'unbuilt' })],
      'module',
      new Map([['billing', 'mod_1']]),
    )
    expect(groups.find((g) => g.label === 'billing')?.id).toBe('mod_1')
    // A module the engine has not materialised yet is still grouped and labelled; it just
    // is not something a card can be dropped onto.
    expect(groups.find((g) => g.label === 'unbuilt')?.id).toBeNull()
  })

  it('groups by blocking reason, so one lane can be split by what it needs', () => {
    const groups = groupLaneTasks(
      [entry({ order: 0, reason: 'failed' }), entry({ order: 1, reason: 'approval' })],
      'blocking_reason',
    )
    expect(groups.map((g) => g.label)).toEqual(['failed', 'approval'])
  })

  it('omits an empty catch-all group rather than rendering an empty header', () => {
    const groups = groupLaneTasks([entry({ moduleName: 'billing' })], 'module')
    expect(groups).toHaveLength(1)
  })
})
