import { computed, ref, watch, type Ref } from 'vue'
import type { Block } from '~/types/domain'
import { useBoardStore } from '~/stores/board'
import {
  containerTargets,
  isTaskContainer,
  reconcileContainer,
  type ContainerTarget,
} from '~/utils/containerTargets'

/**
 * Where a board-authoring surface creates, tracking a live board.
 *
 * `openedFrom` is the frame id the surface was opened WITH, and is resolved through the board on
 * every read rather than trusted: an id alone cannot say whether the block still exists or was ever
 * a legal container. When it resolves and the frame holds no modules there is exactly one answer,
 * so `stated` is true and the caller renders a line naming it instead of a picker asking a question
 * the header button already answered. A frame WITH modules did not answer it, so the picker stays,
 * scoped to that frame.
 *
 * Shared by `<TaskImportModal>` and `<BugHuntModal>`, which are opened from the same two frame
 * header buttons with the same payload: as two copies they disagreed about whether the frame was
 * the answer or the question.
 */
export function useContainerTargets(openedFrom: () => string | null | undefined): {
  /** The frame or module the surface was opened from, while the board still holds it. */
  pinned: Ref<Block | undefined>
  items: Ref<ContainerTarget[]>
  containerId: Ref<string | undefined>
  /** One legal target, so the surface states where the work lands rather than asking. */
  stated: Ref<boolean>
  /** Re-seed the selection; the caller invokes this when the surface opens. */
  reset: () => void
} {
  const board = useBoardStore()

  const pinned = computed<Block | undefined>(() => {
    const id = openedFrom()
    const block = id ? board.getBlock(id) : undefined
    return isTaskContainer(block) ? block : undefined
  })

  const items = computed(() => containerTargets(board.blocks, pinned.value))

  const containerId = ref<string | undefined>(undefined)

  function reset() {
    containerId.value = reconcileContainer(items.value, pinned.value?.id)
  }

  // The board is live, so what is on offer moves under the open surface: a deleted frame, a new
  // module. Watching the TARGETS rather than seeding once is what keeps the selection legal, and
  // it is the reason the pinned frame is re-resolved on every read instead of captured on open.
  watch(items, (next) => {
    const resolved = reconcileContainer(next, containerId.value)
    if (resolved !== containerId.value) containerId.value = resolved
  })

  const stated = computed(() => !!pinned.value && items.value.length === 1)

  return { pinned, items, containerId, stated, reset }
}
