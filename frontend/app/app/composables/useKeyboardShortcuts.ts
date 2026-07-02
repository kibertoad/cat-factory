import { onBeforeUnmount, onMounted } from 'vue'

/**
 * The app-wide keyboard shortcuts, registered ONCE from `pages/index.vue` (mirroring the
 * ⌘K handler in `CommandBar.vue`). Keeping a single global listener — rather than one per
 * component — is what stops N handlers each firing a delete.
 *
 *   · Escape    — deselect the current block / close the inspector, but ONLY when no modal
 *                 is open (every modal is a `UModal` with `role="dialog"`, which already
 *                 handles its own Escape, so we must not also steal it).
 *   · Delete    — delete the selected block, through the SAME confirm-gated path the
 *                 inspector button uses (`useBlockDeletion`). Guarded so it never fires
 *                 while the user is typing in a field. NOTE: only `Delete`, deliberately
 *                 NOT `Backspace` — `Backspace` collides with "navigate back" muscle memory
 *                 and would delete the selected block from anywhere on the board.
 *   · ?         — toggle the keyboard-shortcuts cheatsheet.
 */
export function useKeyboardShortcuts(): void {
  const ui = useUiStore()
  const board = useBoardStore()
  const { deleteBlock } = useBlockDeletion()

  /** A modal / full-screen window is on screen — let it own the keyboard; don't run global
   * shortcuts (else e.g. Delete would delete the selected block hidden BEHIND the window). The
   * hand-rolled result-view + focus windows now carry `role="dialog"`, so the DOM check catches
   * them; the store flags are belt-and-suspenders for the same windows. */
  function modalOpen(): boolean {
    return (
      ui.commandBarOpen ||
      !!ui.resultView ||
      !!ui.focusBlockId ||
      !!document.querySelector('[role="dialog"]')
    )
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
    // "?" — toggle the cheatsheet. Shift+/ on most layouts; guard against typing. The
    // cheatsheet is itself a modal, so allow the toggle to close it (a plain `modalOpen()`
    // guard would trap it open, since "?" could then only ever open, never close).
    if (e.key === '?' && !isEditableTarget(e) && (!modalOpen() || ui.shortcutsHelpOpen)) {
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

    if (e.key === 'Delete') {
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
