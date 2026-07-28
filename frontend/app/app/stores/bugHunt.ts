import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { BugHuntResult, RunBugHuntInput, TaskSourceKind, TrackerBoard } from '~/types/domain'
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

  const result = ref<BugHuntResult | null>(null)
  const hunting = ref(false)
  const huntError = ref<string | null>(null)
  /** The candidate currently being adopted, so only its own row shows a spinner. */
  const adopting = ref<string | null>(null)

  const candidates = computed(() => result.value?.candidates ?? [])
  const hasResult = computed(() => result.value !== null)

  /** Load the boards a hunt can run against for one source. */
  async function loadBoards(source: TaskSourceKind): Promise<void> {
    boardsLoading.value = true
    boardsError.value = null
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
    } finally {
      boardsLoading.value = false
    }
  }

  /** Run a hunt and keep its ranked result. Returns false when the scan itself failed. */
  async function hunt(source: TaskSourceKind, input: RunBugHuntInput): Promise<boolean> {
    hunting.value = true
    huntError.value = null
    try {
      result.value = await api.runBugHunt(workspace.requireId(), source, input)
      return true
    } catch (e) {
      result.value = null
      huntError.value = e instanceof Error ? e.message : String(e)
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
    adopting.value = null
  }

  return {
    boards,
    boardsSource,
    boardsLoading,
    boardsError,
    result,
    candidates,
    hasResult,
    hunting,
    huntError,
    adopting,
    loadBoards,
    hunt,
    adopt,
    reset,
  }
})
