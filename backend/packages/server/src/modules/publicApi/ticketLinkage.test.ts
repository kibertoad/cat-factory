import type { RecordedLogLine } from '@cat-factory/kernel'
import { ConflictError, createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { TicketLinkageDeps } from './ticketLinkage.js'
import { resolveTicket } from './ticketLinkage.js'

// Filing a public-API task FROM a tracker ticket, at the level the ORDERING is visible: the
// worker integration suite drives the happy path and the two refusals over a real HTTP request,
// but it cannot interleave two filings of one ticket, and the interleaving is what the claim
// exists for. Here the collaborators are stubs, so the race can simply be told to happen.

/** The issue projection as far as this module is concerned. */
interface Issue {
  externalId: string
  linkedBlockId: string | null
}

interface Harness {
  deps: TicketLinkageDeps
  issue: Issue
  removed: string[]
  logLines: RecordedLogLine[]
  /** What the claim does when it runs: take it, lose it to `holder`, or fail outright. */
  claimOutcome:
    | { kind: 'win' }
    | { kind: 'lost'; holder: string }
    | { kind: 'throws'; after: 'landed' | 'nothing' }
}

function harness(issue: Issue): Harness {
  const removed: string[] = []
  const logLines: RecordedLogLine[] = []
  const h: Harness = {
    issue,
    removed,
    logLines,
    claimOutcome: { kind: 'win' },
    deps: undefined as unknown as TicketLinkageDeps,
  }
  const linkService = {
    claimForBlock: async (_ws: string, blockId: string) => {
      const outcome = h.claimOutcome
      if (outcome.kind === 'win') {
        h.issue.linkedBlockId = blockId
        return {}
      }
      if (outcome.kind === 'lost') {
        h.issue.linkedBlockId = outcome.holder
        throw new ConflictError('already linked', 'ticket_already_linked', {
          taskId: outcome.holder,
        })
      }
      // The store failed to REPORT, which is not the same as failing to write: `landed` is the
      // write that took effect behind a lost response.
      if (outcome.after === 'landed') h.issue.linkedBlockId = blockId
      throw new Error('store unavailable')
    },
    holderOf: async () => h.issue.linkedBlockId,
  }
  h.deps = {
    tasks: {
      importService: { import: async () => h.issue },
      linkService,
    },
    boardService: {
      removeBlock: async (_ws: string, blockId: string) => {
        removed.push(blockId)
      },
    },
    logger: createRecordingLogger(logLines),
  } as unknown as TicketLinkageDeps
  return h
}

const TICKET = { source: 'jira', ref: 'PROJ-1' } as const

describe('resolveTicket', () => {
  it('refuses a ticket that already has a task BEFORE the board is touched', async () => {
    const h = harness({ externalId: 'PROJ-1', linkedBlockId: 'task_first' })

    // The refusal is the whole of `resolveTicket`, so the caller never reaches its create: a
    // redelivering integration is told which task covers the ticket and files nothing.
    await expect(resolveTicket(h.deps, 'ws_1', TICKET)).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'ticket_already_linked', taskId: 'task_first' },
    })
    expect(h.removed).toEqual([])
  })

  it('claims the ticket for the created task', async () => {
    const h = harness({ externalId: 'PROJ-1', linkedBlockId: null })
    const linkage = await resolveTicket(h.deps, 'ws_1', TICKET)
    await linkage.claim('task_new')

    expect(h.issue.linkedBlockId).toBe('task_new')
    expect(h.removed).toEqual([])
  })

  it('rolls the task back off the board when another filing won the race', async () => {
    // The pre-check passed (the ticket was free when this request read it) and the block was
    // created, but a concurrent filing claimed the ticket in between. Keeping the task here is
    // what an integration cannot recover from: it has an error, so it retries, and the leftover
    // is a duplicate the platform can no longer tell from real work.
    const h = harness({ externalId: 'PROJ-1', linkedBlockId: null })
    const linkage = await resolveTicket(h.deps, 'ws_1', TICKET)
    h.claimOutcome = { kind: 'lost', holder: 'task_winner' }

    await expect(linkage.claim('task_loser')).rejects.toMatchObject({
      details: { reason: 'ticket_already_linked', taskId: 'task_winner' },
    })
    expect(h.removed).toEqual(['task_loser'])
    // The winner keeps the ticket: a rollback must never disturb the link it lost to.
    expect(h.issue.linkedBlockId).toBe('task_winner')
  })

  it('rolls back a task whose claim FAILED without landing', async () => {
    const h = harness({ externalId: 'PROJ-1', linkedBlockId: null })
    const linkage = await resolveTicket(h.deps, 'ws_1', TICKET)
    h.claimOutcome = { kind: 'throws', after: 'nothing' }

    await expect(linkage.claim('task_new')).rejects.toThrow('store unavailable')
    expect(h.removed).toEqual(['task_new'])
    // The store error reaches the caller: the rollback tidies up, it never reports success.
  })

  it('KEEPS a task whose claim failed to report but had already landed', async () => {
    // The dangerous half of a thrown claim. Rolling back here would leave the ticket pointing at
    // a task that no longer exists, which refuses every future filing of it while naming a task
    // nobody can open. So the row is asked rather than the exception believed.
    const h = harness({ externalId: 'PROJ-1', linkedBlockId: null })
    const linkage = await resolveTicket(h.deps, 'ws_1', TICKET)
    h.claimOutcome = { kind: 'throws', after: 'landed' }

    await expect(linkage.claim('task_new')).rejects.toThrow('store unavailable')
    expect(h.removed).toEqual([])
    expect(h.issue.linkedBlockId).toBe('task_new')
  })

  it('reports a rollback it could not perform instead of swallowing it', async () => {
    const h = harness({ externalId: 'PROJ-1', linkedBlockId: null })
    const linkage = await resolveTicket(h.deps, 'ws_1', TICKET)
    h.claimOutcome = { kind: 'lost', holder: 'task_winner' }
    h.deps.boardService.removeBlock = async () => {
      throw new Error('board write failed')
    }

    // The refusal still reaches the caller unchanged (a failed tidy-up must not replace the
    // error that explains what happened), but it leaves a line naming what was left behind.
    await expect(linkage.claim('task_loser')).rejects.toMatchObject({
      details: { reason: 'ticket_already_linked' },
    })
    expect(h.logLines.some((line) => line.level === 'warn')).toBe(true)
  })
})
