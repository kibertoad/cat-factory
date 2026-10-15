import type { Decorator, Meta, StoryObj } from '@storybook/vue3'
import { h } from 'vue'
import { useConfirm, type ConfirmRequest } from '~/composables/useConfirm'
import ConfirmDialog from './ConfirmDialog.vue'

// The app's one confirm dialog. A component awaits `useConfirm().confirm(...)` and the dialog,
// mounted once, shows the request. Each story sends one of the app's own requests in its own
// words. The state is shared by every story, so a story cancels the request the one before left
// open before it sends its own.
const asking =
  (request: (t: ReturnType<typeof useI18n>['t']) => ConfirmRequest): Decorator =>
  (story) => {
    const Story = story()
    return {
      setup() {
        const { t } = useI18n()
        const confirm = useConfirm()
        confirm.cancel()
        void confirm.confirm(request(t))
        return () => h(Story)
      },
    }
  }

const meta = {
  title: 'Primitives/Components/ConfirmDialog',
  component: ConfirmDialog,
} satisfies Meta<typeof ConfirmDialog>
export default meta

type Story = StoryObj<typeof meta>

/** Archiving a service: a plain confirm with an icon. */
export const Default: Story = {
  decorators: [
    asking((t) => ({
      title: t('panels.inspector.confirmArchive.title'),
      description: t('panels.inspector.confirmArchive.body', { name: 'Auth service' }),
      confirmLabel: t('panels.inspector.archiveService'),
      icon: 'i-lucide-archive',
    })),
  ],
}

/** Deleting a board's merge policy: the icon and the confirm button in the error colour. */
export const Destructive: Story = {
  decorators: [
    asking((t) => ({
      title: t('settings.riskPolicy.confirmDelete.title'),
      description: t('settings.riskPolicy.confirmDelete.body', { name: 'Release train' }),
      variant: 'destructive',
      confirmLabel: t('common.delete'),
      icon: 'i-lucide-trash-2',
    })),
  ],
}

/** Closing a form with unsaved changes: both buttons carry their own labels. */
export const CustomLabels: Story = {
  decorators: [
    asking((t) => ({
      title: t('common.discard.title'),
      description: t('common.discard.body'),
      confirmLabel: t('common.discard.confirm'),
      cancelLabel: t('common.discard.keep'),
      variant: 'destructive',
      icon: 'i-lucide-triangle-alert',
    })),
  ],
}
