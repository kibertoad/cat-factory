import { describe, expect, it } from 'vitest'
import { formatDuration } from '../src/deadline.ts'
import type { JournalEvent } from '../src/journal.ts'
import { formatPassStatus, summarisePass } from '../src/status.ts'
import { emptyWorld, type World } from '../src/world.ts'

// What is pinned here is the REDUCTION, because the status command's whole value is answering
// "is it moving" from outside the process, and every way of getting that wrong reads as a normal
// report: a phase whose last observation is an hour old shown as open with no elapsed, or an
// unfinished pass rendered identically to a finished one.

const at = (ms: number) => 1_000_000 + ms

function event(partial: Partial<JournalEvent> & { message: string }): JournalEvent {
  return { at: at(0), phase: '01-bootstrap', kind: 'observation', ...partial }
}

function summarise(input: { world?: World; events?: JournalEvent[]; now?: number }) {
  return summarisePass({
    world: input.world ?? emptyWorld('run-1'),
    events: input.events ?? [],
    ledgerPath: '/tmp/run-1.json',
    journalPath: '/tmp/run-1.journal.jsonl',
    now: input.now ?? at(0),
  })
}

describe('summarisePass', () => {
  it('groups events into phases in the order they were first seen', () => {
    const status = summarise({
      events: [
        event({ phase: '01-bootstrap', kind: 'phase-started', message: 'entered', at: at(0) }),
        event({ phase: '02-feature', kind: 'phase-started', message: 'entered', at: at(500) }),
        event({ phase: '01-bootstrap', message: 'late line', at: at(900) }),
      ],
    })
    expect(status.phases.map((phase) => phase.phase)).toEqual(['01-bootstrap', '02-feature'])
    expect(status.phases[0]?.lastMessage).toBe('late line')
  })

  it('marks a phase finished only when it said so, and keeps the rest open', () => {
    const status = summarise({
      events: [
        event({ phase: '01-bootstrap', kind: 'phase-finished', message: 'both services up' }),
        event({ phase: '02-feature', message: 'coder working' }),
      ],
    })
    expect(status.phases[0]?.finished).toBe('both services up')
    expect(status.phases[1]?.finished).toBeNull()
  })

  it('re-opens a phase a later pass entered again, rather than leaving it done', () => {
    // The journal accumulates across attempts at one run id, so this is what the status command
    // shows all day on a resumed pass: a spec that finished yesterday, was re-entered this
    // morning and is working now would otherwise render `done` under yesterday's message.
    const status = summarise({
      events: [
        event({
          phase: '02-feature',
          kind: 'phase-finished',
          message: 'backend shipped',
          at: at(0),
        }),
        event({ phase: '02-feature', kind: 'phase-started', message: 'entered', at: at(90_000) }),
        event({ phase: '02-feature', message: 'coder working', at: at(120_000) }),
      ],
    })
    expect(status.phases[0]?.finished).toBeNull()
    // Re-anchored to the re-entry: an elapsed time spanning the gap between two passes answers
    // nothing that anyone reads this report to find out.
    expect(status.phases[0]?.startedAt).toBe(at(90_000))
  })

  it('re-opens a phase that finished and then kept writing', () => {
    // Spec 02 finishes a phase per service, so this is the ordinary shape rather than an edge:
    // between the two, the phase is working and must not read as done.
    const status = summarise({
      events: [
        event({
          phase: '02-feature',
          kind: 'phase-finished',
          message: 'backend shipped',
          at: at(0),
        }),
        event({ phase: '02-feature', message: 'frontend coder working', at: at(60_000) }),
      ],
    })
    expect(status.phases[0]?.finished).toBeNull()
    expect(status.phases[0]?.lastMessage).toBe('frontend coder working')
  })

  it('keeps the report in first-seen order when a phase is re-entered', () => {
    const status = summarise({
      events: [
        event({ phase: '01-bootstrap', kind: 'phase-started', message: 'entered', at: at(0) }),
        event({ phase: '02-feature', kind: 'phase-started', message: 'entered', at: at(100) }),
        event({ phase: '01-bootstrap', kind: 'phase-started', message: 'entered', at: at(200) }),
      ],
    })
    expect(status.phases.map((phase) => phase.phase)).toEqual(['01-bootstrap', '02-feature'])
  })

  it('reports a phase whose start line it never saw', () => {
    // A journal is read mid-write and across resumes, so a phase can be present only through its
    // observations. Dropping it would report a working spec as absent, which is the opposite fact.
    const status = summarise({ events: [event({ phase: '03-bugfix', message: 'still going' })] })
    expect(status.phases).toHaveLength(1)
    expect(status.phases[0]?.phase).toBe('03-bugfix')
  })

  it('measures idleness from the last line, which is what separates alive from wedged', () => {
    const status = summarise({
      events: [event({ message: 'last thing', at: at(0) })],
      now: at(600_000),
    })
    expect(status.idleMs).toBe(600_000)
  })

  it('distinguishes a pass that has written nothing from one that is merely quiet', () => {
    // Null rather than zero: "no journal at all" and "wrote something a moment ago" need
    // different reactions, and rendering both as 0ms would hide the first.
    expect(summarise({}).idleMs).toBeNull()
  })

  it('surfaces a bootstrap that started and never settled', () => {
    const world = { ...emptyWorld('run-1'), bootstrapJobs: { backend: 'job_1', frontend: null } }
    const status = summarise({ world })
    expect(status.pendingBootstraps).toEqual([{ role: 'backend', jobId: 'job_1' }])
  })

  it('lists only the records the ledger actually holds', () => {
    const world: World = {
      ...emptyWorld('run-1'),
      backend: { blockId: 'blk_1', serviceId: 'blk_1', repoName: 'api', repoUrl: null },
      bugfix: { taskId: 'tsk_3', runId: 'run_3', pullRequestUrl: null, answeredKinds: [] },
    }
    const status = summarise({ world })
    expect(status.services.map((entry) => entry.role)).toEqual(['backend'])
    expect(status.runs.map((entry) => entry.role)).toEqual(['bugfix'])
  })
})

describe('formatPassStatus', () => {
  it('always ends with the command that resumes this exact pass', () => {
    // The value an operator needs and cannot recover any other way once the terminal is gone.
    const rendered = formatPassStatus(summarise({}), formatDuration)
    expect(rendered).toContain('ACCEPTANCE_RUN_ID=run-1')
  })

  it('says outright that nothing has been recorded, rather than rendering an empty report', () => {
    expect(formatPassStatus(summarise({}), formatDuration)).toContain('No progress recorded yet')
  })

  it('shows a pull request once one exists', () => {
    const world: World = {
      ...emptyWorld('run-1'),
      featureBackend: {
        taskId: 'tsk_1',
        runId: 'run_1',
        pullRequestUrl: 'https://example/pr/1',
        answeredKinds: [],
      },
    }
    expect(formatPassStatus(summarise({ world }), formatDuration)).toContain('https://example/pr/1')
  })
})
