import { watch } from 'vue'
import type { WatchSource } from 'vue'

/**
 * Run `fn` whenever a modal opens, INCLUDING the render it mounts on.
 *
 * This exists because `watch(open, (isOpen) => { if (isOpen) … })` is wrong in this SPA and reads
 * as right. The page mounts most panels only WHILE their open flag is set
 * (`<AssistantModal v-if="ui.assistantOpen" />`), so `open` is already `true` when the component
 * sets up and a change-only watcher never fires at all: whatever the body seeds (a picker's
 * default, the read that fills a catalog) never happens, and the panel opens with an unselected
 * control and a confirm button that cannot be pressed. Nothing throws, which is why it survived in
 * several modals at once.
 *
 * `{ immediate: true }` is the whole fix, and a shared helper is how it stops being per-site
 * knowledge: a panel that IS always mounted passes a `false` on that first run and the body is
 * skipped, so this is correct either way and nobody has to know which kind they are writing.
 *
 * Only for work done on the way IN. A watcher acting on the CLOSE edge (emitting `close`, revoking
 * object URLs) stays a plain `watch`: it has nothing to do at mount, and running it there would
 * announce a close that never happened.
 */
export function onModalOpen(open: WatchSource<boolean>, fn: () => void): void {
  watch(
    open,
    (isOpen) => {
      if (isOpen) fn()
    },
    { immediate: true },
  )
}
