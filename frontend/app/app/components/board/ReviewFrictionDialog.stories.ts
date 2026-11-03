import type { Meta, StoryObj } from '@storybook/vue3'
import { withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import type { ReviewDebtRow, ReviewFrictionModalContext } from '~/stores/ui/modals'
import ReviewFrictionDialog from './ReviewFrictionDialog.vue'

// The dialog the review debt gate raises when a new task is refused because too many tasks wait
// on human review. It lists the waiting tasks, worst first, each a link to its card. The soft tier
// offers Create anyway; the hard tier does not. The context comes from the parsed 409, and the
// form that raised it supplies the callbacks, so each story opens the dialog with its own.
const meta = {
  title: 'Board/Components/ReviewFrictionDialog',
  component: ReviewFrictionDialog,
} satisfies Meta<typeof ReviewFrictionDialog>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Three tasks waiting on review, worst first. A row with no title shows Untitled task. The ids are
 * not on the shared board, so no row contradicts a shared fixture.
 */
const debt: ReviewDebtRow[] = [
  { blockId: 'task_audit_trail', title: 'Record an audit trail for exports', waitingMinutes: 1460 },
  { blockId: 'task_cache', title: 'Cache session lookups', waitingMinutes: 312 },
  { blockId: 'task_untitled', title: null, waitingMinutes: 45 },
]

function withFriction(ctx: Partial<ReviewFrictionModalContext>) {
  return withSeed(() =>
    useUiStore().openReviewFriction({
      kind: 'warn',
      debt,
      onConfirm: () => {},
      onLeave: () => {},
      ...ctx,
    }),
  )
}

/**
 * The soft tier: the count, the waiting tasks, and Create anyway beside Close and Go review. The
 * waits show in minutes however long they are, so a day reads as 1460 min.
 */
export const Default: Story = {
  decorators: [withFriction({})],
}

/** The hard tier by count: no Create anyway, and the body names the limit. */
export const BlockedByCount: Story = {
  decorators: [withFriction({ kind: 'blocked', reason: 'count', threshold: 3, onConfirm: null })],
}

/** The hard tier because one task waited too long: the body names the age limit. */
export const BlockedStuck: Story = {
  decorators: [
    withFriction({ kind: 'blocked', reason: 'stuck', threshold: 1440, onConfirm: null }),
  ],
}

/**
 * Create anyway was clicked and the create is in flight: it spins, and every way out is
 * disabled, so the dialog cannot close while the task is being filed.
 */
export const Pending: Story = {
  decorators: [withFriction({ pending: () => true })],
}
