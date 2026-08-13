import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useBugHuntStore } from '~/stores/bugHunt'
import { useWorkspaceStore } from '~/stores/workspace'
import { ApiError } from '~/composables/api/errors'
import type { TaskSourceKind, TrackerBoardsView } from '~/types/domain'

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
} {
  let handler: () => Promise<unknown> = () => Promise.resolve({ source: 'jira', boards: [] })
  vi.stubGlobal('useApi', () => ({
    listTrackerBoards: (_ws: string, _source: TaskSourceKind) =>
      handler() as Promise<TrackerBoardsView>,
  }))
  return {
    store: useBugHuntStore(),
    serve: (fn) => {
      handler = fn
    },
  }
}

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
})
