// The app-wide confirm dialog, for a story whose component asks `useConfirm().confirm(...)`.
//
// The app mounts ONE `ConfirmDialog` in `pages/index.vue`, and a component only awaits the
// answer, so a story of that component shows nothing when the user clicks Stop or Delete. This
// decorator mounts the dialog beside the story. Its state lives at module scope and so outlives
// a story: the decorator cancels a request left open by the story shown before.
import { h } from 'vue'
import type { Decorator } from '@storybook/vue3'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import { useConfirm } from '~/composables/useConfirm'

/** `story()` is called once, outside the render function, as in `withSeed`. */
export const withConfirmDialog: Decorator = (story) => {
  const Story = story()
  return {
    setup() {
      useConfirm().cancel()
      return () => [h(Story), h(ConfirmDialog)]
    },
  }
}
