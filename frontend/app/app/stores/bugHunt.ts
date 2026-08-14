import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { BugHuntResult, RunBugHuntInput, TaskSourceKind, TrackerBoard } from '~/types/domain'
import { apiErrorReason } from '~/composables/api/errors'
import { useWorkspaceStore } from '~/stores/workspace'
import { usePersonalSubscriptionsStore } from '~/stores/personalSubscriptions'

/**
 * Bug-hunt state: the boards of the tracker being browsed, the last hunt's ranked candidates,
 * and the actions behind the three steps (list boards → run the hunt → adopt one candidate).
 *
 * Nothing here is persisted server-side — a hunt is a live read plus a ranking, so the store
 * holds the whole feature's state and a page reload starts a fresh hunt. That is deliberate:
 * a stale ranking of a board that has since moved on is worse than no ranking.
 */
export const useBugHuntStore = defineStore('bugHunt', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  /** Boards of the last source `loadBoards` was called for, keyed so a source switch re-fetches. */
  const boards = ref<TrackerBoard[]>([])
  const boardsSource = ref<TaskSourceKind | null>(null)
  const boardsLoading = ref(false)
  /**
   * Why board listing failed, if it did. Kept rather than swallowed: a source whose provider
   * can't enumerate boards is a normal, actionable state (type the board in yourself), and an
   * empty picker alone doesn't say that.
   */
  const boardsError = ref<string | null>(null)
  /**
   * The backend's machine-readable reason for that failure. Only `boards_unsupported` means
   * "this tracker cannot enumerate boards, so type one in"; every other failure (an unreachable
   * site, an expired token) is a real error and must be shown as one — offering a free-text
   * field there would just move the same failure to the next click.
   */
  const boardsErrorReason = ref<string | null>(null)

  const result = ref<BugHuntResult | null>(null)
  const hunting = ref(false)
  const huntError = ref<string | null>(null)
  /**
   * The backend's machine-readable reason for a failed scan, kept for the same reason
   * {@link boardsErrorReason} is: `repo_not_linked` says the service this hunt is scoped to has
   * no repository to read issues from, which is a state the person can fix on the board and the
   * only one the surface words itself. Every other failure stays a toast.
   */
  const huntErrorReason = ref<string | null>(null)
  /** The candidate currently being adopted, so only its own row shows a spinner. */
  const adopting = ref<string | null>(null)

  const candidates = computed(() => result.value?.candidates ?? [])
  const hasResult = computed(() => result.value !== null)

  /** Load the boards a hunt can run against for one source. */
  async function loadBoards(source: TaskSourceKind): Promise<void> {
    boardsLoading.value = true
    boardsError.value = null
    boardsErrorReason.value = null
    boardsSource.value = source
    try {
      const view = await api.listTrackerBoards(workspace.requireId(), source)
      // A source switch mid-flight would otherwise land the slower response over the newer
      // one, leaving the picker showing another tracker's boards.
      if (boardsSource.value !== source) return
      boards.value = view.boards
    } catch (e) {
      if (boardsSource.value !== source) return
      boards.value = []
      boardsError.value = e instanceof Error ? e.message : String(e)
      boardsErrorReason.value = apiErrorReason(e)
    } finally {
      // Only the listing the picker is still showing owns the flag. A superseded one clearing it
      // unconditionally would report the tracker now being loaded as done, which is the same
      // mistake in the opposite direction from the one `dropBoards` avoids.
      if (boardsSource.value === source) boardsLoading.value = false
    }
  }

  /**
   * Forget the board listing, because the tracker now in the picker has none to offer: its board
   * is the chosen service's repository, resolved server-side. Called INSTEAD of `loadBoards`, so a
   * previous tracker's list (or its failure, which the surface renders as a warning) cannot sit
   * under a tracker that has no board field at all. `boardsSource` moves with it, so a listing
   * still in flight for that previous tracker lands on nothing rather than reviving the picker.
   */
  function dropBoards(source: TaskSourceKind): void {
    boardsSource.value = source
    boards.value = []
    boardsError.value = null
    boardsErrorReason.value = null
    // The listing in flight belongs to the tracker being left, and its `finally` will not run
    // until it settles — indefinitely, if that tracker hangs. Clearing the flag with the rest of
    // the state is what makes "land on nothing" true of the WHOLE listing rather than of four of
    // its five fields, so a reader gating on it cannot wait on a request nobody is waiting for.
    boardsLoading.value = false
  }

  /** Run a hunt and keep its ranked result. Returns false when the scan itself failed. */
  async function hunt(source: TaskSourceKind, input: RunBugHuntInput): Promise<boolean> {
    hunting.value = true
    huntError.value = null
    huntErrorReason.value = null
    try {
      result.value = await api.runBugHunt(workspace.requireId(), source, input)
      return true
    } catch (e) {
      result.value = null
      huntError.value = e instanceof Error ? e.message : String(e)
      huntErrorReason.value = apiErrorReason(e)
      return false
    } finally {
      hunting.value = false
    }
  }

  /**
   * Adopt a candidate as a bug task and start its run. Rides the personal password like every
   * other run start, so an individual-usage model prompts here rather than failing the start.
   * Returns the new block's id on success, null when the user cancelled the credential prompt.
   */
  async function adopt(
    source: TaskSourceKind,
    externalId: string,
    containerId: string,
    pipelineId?: string,
  ): Promise<string | null> {
    const personal = usePersonalSubscriptionsStore()
    adopting.value = externalId
    try {
      let blockId: string | null = null
      const ok = await personal.withCredential(async (password) => {
        const adopted = await api.adoptBugHuntCandidate(
          workspace.requireId(),
          source,
          { externalId, containerId, ...(pipelineId ? { pipelineId } : {}) },
          password,
        )
        blockId = adopted.block.id
        await workspace.refresh()
      })
      return ok ? blockId : null
    } finally {
      adopting.value = null
    }
  }

  /** Drop the last hunt (on close, or when the source/board changes under it). */
  function reset(): void {
    result.value = null
    huntError.value = null
    huntErrorReason.value = null
    adopting.value = null
  }

  return {
    boards,
    boardsSource,
    boardsLoading,
    boardsError,
    boardsErrorReason,
    result,
    candidates,
    hasResult,
    hunting,
    huntError,
    huntErrorReason,
    adopting,
    loadBoards,
    dropBoards,
    hunt,
    adopt,
    reset,
  }
})
