import type {
  KaizenGrading,
  PublicKaizenEntry,
  PublicKaizenEntryList,
} from '@cat-factory/contracts'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { handleError } from '../../http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'
import { publicKaizenController } from './PublicKaizenController.js'

// What only the assembled route can show: the scope ladder in front of each verb, the keyset
// cursor a client pages on, and the two refusals a headless caller has to branch on.
//
// The repository behaviour underneath (the SQL filters, the first-acknowledgement-wins write, the
// sweep not clobbering a triage) is asserted once per facade in the conformance suite, against
// real stores. What is asserted here is what that suite structurally cannot see: that `read`
// cannot acknowledge, that a corrupt cursor is refused rather than silently re-serving page one,
// and that a refusal comes back through the real error funnel carrying `details.reason`.

const NOW = 1_000

function grading(over: Partial<KaizenGrading> & Pick<KaizenGrading, 'id'>): KaizenGrading {
  return {
    executionId: 'run_1',
    blockId: 'blk_1',
    stepIndex: 0,
    agentKind: 'coder',
    model: 'anthropic:claude',
    promptVersion: 3,
    comboKey: 'coder|anthropic:claude|3',
    status: 'complete',
    grade: 2,
    summary: 'The agent thrashed on the build command.',
    recommendations: ['name the package manager in the prompt'],
    graderModel: 'anthropic:claude',
    error: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgementNote: null,
    createdAt: 10,
    updatedAt: 10,
    ...over,
  }
}

/**
 * A container whose Kaizen module is the REAL service over in-memory stores, so the controller is
 * exercised against the same projection and refusals production runs, rather than against a stub
 * that agrees with it by construction.
 */
function harness(opts: { scope?: string; rows?: KaizenGrading[] } = {}) {
  const rows = new Map((opts.rows ?? [grading({ id: 'kzn_1' })]).map((row) => [row.id, row]))
  const kaizen = {
    service: {
      listEntries: async (_ws: string, query: { limit: number; acknowledged?: boolean }) =>
        [...rows.values()]
          .filter((row) =>
            query.acknowledged === undefined
              ? true
              : query.acknowledged === (row.acknowledgedAt !== null),
          )
          .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
          .slice(0, query.limit)
          .map(toEntry),
      getEntry: async (_ws: string, entryId: string) => {
        const row = rows.get(entryId)
        return row ? toEntry(row) : null
      },
      acknowledgeEntry: async (
        _ws: string,
        entryId: string,
        input: { acknowledged: boolean; note: string | null; actor: string | null },
      ) => {
        const row = rows.get(entryId)
        if (!row) throw new Error('unreachable in these cases')
        const next: KaizenGrading = input.acknowledged
          ? {
              ...row,
              acknowledgedAt: NOW,
              acknowledgedBy: input.actor,
              acknowledgementNote: input.note,
            }
          : { ...row, acknowledgedAt: null, acknowledgedBy: null, acknowledgementNote: null }
        rows.set(entryId, next)
        return toEntry(next)
      },
    },
  }
  const container = {
    kaizen,
    publicApiKeys: {
      authenticate: async (secret?: string) =>
        secret === 'good'
          ? {
              workspaceId: 'ws_1',
              scope: opts.scope ?? 'write',
              keyId: 'pak_1',
              actsAsUserId: null,
            }
          : null,
    },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/', publicKaizenController())

  return async (path: string, init: RequestInit = {}) => {
    const res = await app.request(`/api/v1${path}`, {
      ...init,
      headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
    })
    return { status: res.status, body: (await res.json()) as never }
  }
}

/** The projection the real service performs; the board context is null in these cases. */
function toEntry(row: KaizenGrading): PublicKaizenEntry {
  return {
    entryId: row.id,
    runId: row.executionId,
    stepIndex: row.stepIndex,
    taskId: row.blockId,
    task: null,
    agentKind: row.agentKind,
    model: row.model,
    promptVersion: row.promptVersion,
    comboKey: row.comboKey,
    combo: null,
    status: row.status,
    grade: row.grade,
    summary: row.summary,
    recommendations: row.recommendations,
    graderModel: row.graderModel,
    error: row.error,
    acknowledged: row.acknowledgedAt !== null,
    acknowledgedAt: row.acknowledgedAt,
    acknowledgedBy: row.acknowledgedBy,
    acknowledgementNote: row.acknowledgementNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const reasonOf = (body: unknown) =>
  (body as { error?: { details?: { reason?: string } } }).error?.details?.reason
const codeOf = (body: unknown) => (body as { error?: { code?: string } }).error?.code

describe('the public Kaizen entry surface', () => {
  it('lists entries with the investigative context and a cursor once a page is full', async () => {
    const call = harness({
      rows: [
        grading({ id: 'kzn_1', createdAt: 10 }),
        grading({ id: 'kzn_2', createdAt: 20, stepIndex: 1 }),
      ],
    })
    const { status, body } = await call('/kaizen/entries?limit=1')
    const page = body as PublicKaizenEntryList

    expect(status).toBe(200)
    // Newest first, and the run + step + model + prompt version ride along, which is the whole
    // point: an entry has to be actionable without a second lookup.
    expect(page.entries[0]?.entryId).toBe('kzn_2')
    expect(page.entries[0]).toMatchObject({
      runId: 'run_1',
      stepIndex: 1,
      agentKind: 'coder',
      model: 'anthropic:claude',
      promptVersion: 3,
      acknowledged: false,
    })
    // A full page hands back a cursor; a client pages until it comes back null.
    expect(page.nextCursor).toBeTruthy()
  })

  it('refuses a malformed cursor rather than silently serving page one again', async () => {
    const call = harness()
    const { status, body } = await call('/kaizen/entries?cursor=not-a-cursor')
    expect(status).toBe(400)
    expect(codeOf(body)).toBe('invalid_cursor')
  })

  it('acknowledges an entry, attributes it to the calling key, and drops it from the backlog', async () => {
    const call = harness()
    const acked = await call('/kaizen/entries/kzn_1/acknowledge', {
      method: 'POST',
      body: JSON.stringify({ note: 'filed as CF-12' }),
    })
    expect(acked.status).toBe(200)
    expect(acked.body as PublicKaizenEntry).toMatchObject({
      acknowledged: true,
      // A key minted onto nobody answers for itself: the id is stable and addressable, where a
      // null would leave a follow-up with nobody to ask.
      acknowledgedBy: 'pak_1',
      acknowledgementNote: 'filed as CF-12',
    })

    const backlog = await call('/kaizen/entries?acknowledged=false')
    expect((backlog.body as PublicKaizenEntryList).entries).toEqual([])
  })

  it('lets a read key look but not acknowledge', async () => {
    const call = harness({ scope: 'read' })
    expect((await call('/kaizen/entries')).status).toBe(200)
    const { status, body } = await call('/kaizen/entries/kzn_1/acknowledge', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(status).toBe(403)
    expect(codeOf(body)).toBe('insufficient_scope')
  })

  it('answers an unknown entry id with the reason a caller branches on', async () => {
    const call = harness()
    const { status, body } = await call('/kaizen/entries/kzn_missing')
    expect(status).toBe(404)
    expect(reasonOf(body)).toBe('kaizen_entry_not_found')
  })
})
