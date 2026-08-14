import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useBugHuntStore } from '~/stores/bugHunt'
import { useWorkspaceStore } from '~/stores/workspace'
import { ApiError } from '~/composables/api/errors'
import type { BugHuntResult, TaskSourceKind, TrackerBoardsView } from '~/types/domain'

// What the board picker does with a FAILED board read. Only one failure means "this tracker
// cannot enumerate boards, so type one in"; every other failure has to stay visible as an error,
// or a tracker outage silently wears the same clothes as an unsupported provider.

function apiError(statusCode: number, code: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(statusCode, { error: { code, message: 'nope', details } })
}

/** The unsupported-source refusal `BugHuntService.listBoards` raises. */
const boardsUnsupported = () =>
  Promise.reject(apiError(400, 'validation', { reason: 'boards_unsupported' }))

/**
 * Stub `useApi` ONCE, behind a handler the test can swap. The store resolves `useApi()` at setup,
 * so re-stubbing after `useBugHuntStore()` would leave it holding the first stub for ever.
 */
function stubApi(): {
  store: ReturnType<typeof useBugHuntStore>
  serve: (fn: () => Promise<unknown>) => void
  serveHunt: (fn: () => Promise<unknown>) => void
} {
  let handler: () => Promise<unknown> = () => Promise.resolve({ source: 'jira', boards: [] })
  let huntHandler: () => Promise<unknown> = () => Promise.resolve(huntResult())
  vi.stubGlobal('useApi', () => ({
    listTrackerBoards: (_ws: string, _source: TaskSourceKind) =>
      handler() as Promise<TrackerBoardsView>,
    runBugHunt: (_ws: string, _source: TaskSourceKind, _input: unknown) =>
      huntHandler() as Promise<BugHuntResult>,
  }))
  return {
    store: useBugHuntStore(),
    serve: (fn) => {
      handler = fn
    },
    serveHunt: (fn) => {
      huntHandler = fn
    },
  }
}

/** An empty but well-formed scan result, so a success case asserts on the store, not the shape. */
function huntResult(): BugHuntResult {
  return {
    source: 'github',
    board: 'acme/web',
    analysisStatus: 'empty',
    model: null,
    candidates: [],
    scanned: 0,
    truncated: false,
  }
}

/** The one scan input shape the modal builds; the store only passes it through. */
const SCAN = { containerId: 'blk_auth', board: null }

describe('bug hunt store — board listing failures', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('keeps the backend reason so the picker can offer free text for an unsupported source', async () => {
    const { store, serve } = stubApi()
    serve(boardsUnsupported)

    await store.loadBoards('jira')

    expect(store.boards).toEqual([])
    expect(store.boardsErrorReason).toBe('boards_unsupported')
    expect(store.boardsError).toBeTruthy()
  })

  it('records NO reason for a failure that is simply an unreachable tracker', async () => {
    const { store, serve } = stubApi()
    serve(() => Promise.reject(apiError(502, 'upstream')))

    await store.loadBoards('jira')

    // The modal keys its free-text fallback on the reason, so a null one keeps this an error.
    expect(store.boardsErrorReason).toBeNull()
    expect(store.boardsError).toBeTruthy()
  })

  it('clears a previous failure when a later source lists its boards fine', async () => {
    const { store, serve } = stubApi()
    serve(boardsUnsupported)
    await store.loadBoards('jira')

    serve(() =>
      Promise.resolve({ source: 'linear', boards: [{ id: 't1', name: 'Eng', key: 'ENG' }] }),
    )
    await store.loadBoards('linear')

    expect(store.boardsError).toBeNull()
    expect(store.boardsErrorReason).toBeNull()
    expect(store.boards.map((b) => b.id)).toEqual(['t1'])
  })

  it('drops the previous tracker failure when the next one has no board to list', async () => {
    // A repo-backed tracker renders no board field at all, so a stale "boards could not be
    // loaded" warning would sit under a control that is not there, blaming this tracker for the
    // last one's outage.
    const { store, serve } = stubApi()
    serve(() => Promise.reject(apiError(502, 'upstream')))
    await store.loadBoards('jira')

    store.dropBoards('github')

    expect(store.boardsSource).toBe('github')
    expect(store.boards).toEqual([])
    expect(store.boardsError).toBeNull()
    expect(store.boardsErrorReason).toBeNull()
  })

  it('a source switch mid-flight never lands the older tracker failure on the newer one', async () => {
    const { store, serve } = stubApi()
    let rejectJira!: (e: unknown) => void
    serve(
      () =>
        new Promise((_res, rej) => {
          rejectJira = rej
        }),
    )
    const inFlight = store.loadBoards('jira')

    serve(() => Promise.resolve({ source: 'linear', boards: [] }))
    await store.loadBoards('linear')
    rejectJira(apiError(400, 'validation', { reason: 'boards_unsupported' }))
    await inFlight

    // The slower tracker's refusal must not flip the newer tracker's picker to free text.
    expect(store.boardsSource).toBe('linear')
    expect(store.boardsErrorReason).toBeNull()
    expect(store.boardsError).toBeNull()
  })

  it('leaves nothing loading when the next tracker has no board to list', async () => {
    // The abandoned listing's own `finally` will not run until it settles, which for a hanging
    // tracker is never. A picker (or a Hunt button) gated on the flag would wait on a request
    // nobody is waiting for.
    const { store, serve } = stubApi()
    serve(() => new Promise(() => {}))
    void store.loadBoards('jira')
    expect(store.boardsLoading).toBe(true)

    store.dropBoards('github')

    expect(store.boardsLoading).toBe(false)
  })

  it('a superseded listing never reports the tracker now loading as done', async () => {
    const { store, serve } = stubApi()
    let settleJira!: (v: unknown) => void
    serve(() => new Promise((res) => (settleJira = res)))
    const inFlight = store.loadBoards('jira')

    serve(() => new Promise(() => {}))
    void store.loadBoards('linear')
    settleJira({ source: 'jira', boards: [] })
    await inFlight

    expect(store.boardsSource).toBe('linear')
    expect(store.boardsLoading).toBe(true)
  })
})

describe('bug hunt store — scan failures', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('keeps the backend reason for the one failure the surface words itself', async () => {
    // `repo_not_linked` names something fixable on this board, so the modal states it beside the
    // scope it invalidates instead of raising a toast. That routing reads ONLY this field.
    const { store, serveHunt } = stubApi()
    serveHunt(() => Promise.reject(apiError(422, 'validation', { reason: 'repo_not_linked' })))

    expect(await store.hunt('github', SCAN)).toBe(false)

    expect(store.huntErrorReason).toBe('repo_not_linked')
    expect(store.huntError).toBeTruthy()
    expect(store.result).toBeNull()
  })

  it('records NO reason for a scan that simply failed, so it stays a toast', async () => {
    const { store, serveHunt } = stubApi()
    serveHunt(() => Promise.reject(apiError(502, 'upstream')))

    expect(await store.hunt('jira', { containerId: 'blk_auth', board: 'PROJ' })).toBe(false)

    expect(store.huntErrorReason).toBeNull()
    expect(store.huntError).toBeTruthy()
  })

  it('clears a previous scan failure once a later scan succeeds', async () => {
    const { store, serveHunt } = stubApi()
    serveHunt(() => Promise.reject(apiError(422, 'validation', { reason: 'repo_not_linked' })))
    await store.hunt('github', SCAN)

    serveHunt(() => Promise.resolve(huntResult()))
    expect(await store.hunt('github', SCAN)).toBe(true)

    expect(store.huntError).toBeNull()
    expect(store.huntErrorReason).toBeNull()
    expect(store.result?.board).toBe('acme/web')
  })

  it('drops the reason on reset, so a re-opened hunt never re-states the old refusal', async () => {
    const { store, serveHunt } = stubApi()
    serveHunt(() => Promise.reject(apiError(422, 'validation', { reason: 'repo_not_linked' })))
    await store.hunt('github', SCAN)

    store.reset()

    expect(store.huntErrorReason).toBeNull()
    expect(store.huntError).toBeNull()
  })
})
