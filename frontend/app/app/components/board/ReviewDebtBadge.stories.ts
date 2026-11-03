import type { Meta, StoryObj } from '@storybook/vue3'
import type { Notification, WorkspaceSettings } from '@cat-factory/contracts'
import { refreshTask, rateLimitTask, loginTask } from '~/stories/board.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useNotificationsStore } from '~/stores/notifications'
import { useWorkspaceSettingsStore } from '~/stores/workspaceSettings'
import ReviewDebtBadge from './ReviewDebtBadge.vue'

// The badge beside a service's add-task control that warns about review debt before the friction
// dialog does. It counts the tasks with an open review-wait card, by the same rule the backend
// enforces (`assessReviewFriction` in contracts), over the open cards and the workspace settings.
// It is hidden while friction is off or the count is under the warn level. The tooltip names the
// count.
const meta = {
  title: 'Board/Components/ReviewDebtBadge',
  component: ReviewDebtBadge,
} satisfies Meta<typeof ReviewDebtBadge>
export default meta

type Story = StoryObj<typeof meta>

const HOUR = 3_600_000

/** An open review-wait card on `blockId`, raised `hoursAgo` hours ago. */
function waitingCard(
  blockId: string,
  type: Notification['type'],
  title: string,
  hoursAgo: number,
): Notification {
  return {
    id: `ntf_${blockId}`,
    type,
    status: 'open',
    blockId,
    executionId: null,
    title,
    body: '',
    createdAt: Date.now() - hoursAgo * HOUR,
    resolvedAt: null,
  }
}

/** Three tasks waiting on a person: a PR to merge, a plan to approve, a finished run. */
const waiting: Notification[] = [
  waitingCard(rateLimitTask.id, 'merge_review', 'Ready to merge', 26),
  waitingCard(loginTask.id, 'decision_required', 'Approve the plan', 5),
  waitingCard(refreshTask.id, 'pipeline_complete', 'Pipeline finished', 1),
]

function withDebt(settings: Partial<WorkspaceSettings>) {
  return withSeed(() => {
    useNotificationsStore().hydrate(waiting)
    const store = useWorkspaceSettingsStore()
    store.settings = { ...store.settings, ...settings }
  })
}

/** Warn mode at its default level of three: the amber badge. */
export const Default: Story = {
  decorators: [withDebt({ reviewFrictionMode: 'warn' })],
}

/**
 * Enforce mode, and the oldest task has waited past the one-day limit: the red badge, because
 * new tasks are refused.
 */
export const Blocked: Story = {
  decorators: [withDebt({ reviewFrictionMode: 'enforce', reviewFrictionBlockStuckMinutes: 1440 })],
}
