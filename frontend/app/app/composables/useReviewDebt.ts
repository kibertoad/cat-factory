import { computed } from 'vue'
import { assessReviewFriction } from '@cat-factory/contracts'
import { useNotificationsStore } from '~/stores/notifications'
import { useWorkspaceSettingsStore } from '~/stores/workspaceSettings'

/**
 * The client-side review-debt verdict, computed from the SAME pure `assessReviewFriction` the
 * backend enforces with, over the workspace snapshot's open notifications + settings. Lets the
 * add-task affordances pre-warn (a debt badge) BEFORE a create is attempted, so the friction
 * dialog is rarely a surprise. The server stays the authority — this is a hint only. See
 * backend/docs/review-debt-friction.md.
 */
export function useReviewDebt() {
  const notifications = useNotificationsStore()
  const settings = useWorkspaceSettingsStore()
  const verdict = computed(() =>
    assessReviewFriction(notifications.open, settings.settings, Date.now()),
  )
  const active = computed(() => verdict.value.kind !== 'ok')
  const debtCount = computed(() => (verdict.value.kind === 'ok' ? 0 : verdict.value.debt.length))
  const blocked = computed(() => verdict.value.kind === 'block')
  return { verdict, active, debtCount, blocked }
}
