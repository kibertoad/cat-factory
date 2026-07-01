import { onBeforeUnmount, onMounted } from 'vue'

/**
 * The app-wide keyboard shortcuts, registered ONCE from `pages/index.vue` (mirroring the
 * ⌘K handler in `CommandBar.vue`). Keeping a single global listener — rather than one per
 * component — is what stops N handlers each firing a delete.
 *
 *   · Escape    — deselect the current block / close the inspector, but ONLY when no modal
 *                 is open (every modal is a `UModal` with `role="dialog"`, which already
 *                 handles its own Escape, so we must not also steal it).
 *   · Delete /  — delete the selected block, through the SAME confirm-gated path the
 *     Backspace   inspector button uses (`useBlockDeletion`). Guarded so it never fires
 *                 while the user is typing in a field.
 *   · ?         — open the keyboard-shortcuts cheatsheet.
 */
export function useKeyboardShortcuts(): void {
  const ui = useUiStore()
  const board = useBoardStore()
  const { deleteBlock } = useBlockDeletion()

  /** A modal (UModal) is on screen — let it own the keyboard; don't run global shortcuts. */
  function modalOpen(): boolean {
    return ui.commandBarOpen || !!document.querySelector('[role="dialog"]')
  }

  /** The event originates from a text field, so printable/Delete keys are edits, not shortcuts. */
  function isEditableTarget(e: KeyboardEvent): boolean {
    const el = e.target as HTMLElement | null
    if (!el) return false
    const tag = el.tagName
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      el.isContentEditable ||
      !!el.closest('input, textarea, select, [contenteditable="true"]')
    )
  }

  function onKeydown(e: KeyboardEvent) {
    // "?" — the cheatsheet. Shift+/ on most layouts; guard against typing.
    if (e.key === '?' && !isEditableTarget(e) && !modalOpen()) {
      e.preventDefault()
      ui.toggleShortcutsHelp()
      return
    }

    if (e.key === 'Escape') {
      // A modal owns Escape (it closes itself); only deselect when nothing is open.
      if (modalOpen()) return
      if (ui.selectedBlockId) {
        e.preventDefault()
        ui.select(null)
      }
      return
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      // Never destroy a block while the user is editing a title/description/query.
      if (isEditableTarget(e) || modalOpen()) return
      const id = ui.selectedBlockId
      if (!id) return
      const block = board.getBlock(id)
      if (!block) return
      e.preventDefault()
      void deleteBlock(block)
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
}
