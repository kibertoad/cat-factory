<script setup lang="ts">
import type { Notification } from '~/types/domain'

// The board's notification inbox: a bell with an open-count badge that opens a
// panel of human-actionable items (a PR awaiting a merge decision, a completed
// pipeline awaiting confirmation, CI that gave up). Each item can be acted on
// (merge / confirm / retry) or dismissed. Hydrated from the snapshot and patched
// live via the `notification` WorkspaceEvent.

const { t, te } = useI18n()

const notifications = useNotificationsStore()
const ui = useUiStore()
const execution = useExecutionStore()
const toast = useToast()

const busy = ref<string | null>(null)

/** Toast a failed act/dismiss — the store throws, so without this a failure was silent and the
 * item just stayed in the inbox with no explanation. */
function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

/** Per-type display metadata (icon, colour). The primary-action label is resolved
 * separately through the i18n catalog (`ACTION_KEYS`). */
type Accent = 'warning' | 'primary' | 'error'
const META: Record<Notification['type'], { icon: string; color: Accent }> = {
  merge_review: { icon: 'i-lucide-git-pull-request-arrow', color: 'warning' },
  pipeline_complete: { icon: 'i-lucide-circle-check', color: 'primary' },
  ci_failed: { icon: 'i-lucide-triangle-alert', color: 'error' },
  test_failed: { icon: 'i-lucide-flask-conical', color: 'error' },
  // Clicking the title opens the review window for the task (see `reveal`); "act" just marks
  // it read (the server performs no side-effect for this type).
  requirement_review: { icon: 'i-lucide-clipboard-list', color: 'primary' },
  // Clicking the title opens the clarity review window for the task (see `reveal`); "act"
  // just marks it read (the server performs no side-effect for this type).
  clarity_review: { icon: 'i-lucide-bug', color: 'primary' },
  // A post-release Datadog regression the on-call agent investigated. The human decides
  // whether to revert (in GitHub via the PR link) or acknowledge; "act" marks it handled.
  release_regression: { icon: 'i-lucide-activity', color: 'error' },
  // Clicking the title opens the parked step's decision surface (companion → step detail
  // with the iteration-cap prompt; requirements → the review window); "act" just marks it
  // read (the decision itself is resolved in that surface, not here).
  decision_required: { icon: 'i-lucide-circle-help', color: 'warning' },
  // Clicking the title opens the human-testing window for the task (see `reveal`); "act" just
  // marks it read (the gate is resolved in that window — confirm / request a fix — not here).
  human_test_ready: { icon: 'i-lucide-user-check', color: 'primary' },
  // Clicking the title opens the visual-confirmation window for the task (see `reveal`); "act"
  // just marks it read (the gate is resolved in that window — approve / request a fix — not here).
  visual_confirmation_ready: { icon: 'i-lucide-camera', color: 'primary' },
  // Clicking the title opens the task's gate window (where the human can request a freeform
  // fix); "act" just marks it read (approval happens on GitHub, not here).
  human_review: { icon: 'i-lucide-users', color: 'primary' },
  // Clicking the title opens the Follow-up companion window for the run (see `reveal`); "act"
  // just marks it read (items are decided in that window — file / send back / answer — not here).
  followup_pending: { icon: 'i-lucide-compass', color: 'warning' },
  // The fork-decision phase surfaced materially different implementation approaches. Clicking
  // the title opens the fork-decision window (see `reveal`); "act" just marks it read (the
  // choice is made in that window — pick a fork / enter a custom approach — not here).
  fork_decision_pending: { icon: 'i-lucide-git-fork', color: 'warning' },
  // The PR reviewer surfaced findings to triage. Clicking the title opens the PR-review window
  // (see `reveal`); "act" just marks it read (findings are selected in that window, not here).
  pr_review_ready: { icon: 'i-lucide-clipboard-check', color: 'primary' },
  // The initiative loop needs attention (a blocked task, or completion). Clicking the title
  // opens the initiative tracker window; "act" just marks it read.
  initiative: { icon: 'i-lucide-milestone', color: 'primary' },
  // The deployment's OWN run health crossed an operator threshold. Not block-scoped: clicking
  // the title opens the operator dashboard (where the live numbers are); "act" marks it read.
  platform_health: { icon: 'i-lucide-server-cog', color: 'warning' },
  // Runs were paused by the spend safeguard. Workspace-scoped (no block to reveal); "act" just
  // marks it read (the human raises the budget then resumes from the spend panel).
  budget_paused: { icon: 'i-lucide-wallet', color: 'warning' },
}

// Per-type primary-action label. An exhaustive Record keyed off the notification
// type union (a missing member fails the typecheck); each value is a LITERAL catalog
// key so the typed-message-keys check sees it. Leaf keys mirror the enum value verbatim.
const ACTION_KEYS: Record<Notification['type'], string> = {
  merge_review: 'layout.notifications.action.merge_review',
  pipeline_complete: 'layout.notifications.action.pipeline_complete',
  ci_failed: 'layout.notifications.action.ci_failed',
  test_failed: 'layout.notifications.action.test_failed',
  requirement_review: 'layout.notifications.action.requirement_review',
  clarity_review: 'layout.notifications.action.clarity_review',
  release_regression: 'layout.notifications.action.release_regression',
  decision_required: 'layout.notifications.action.decision_required',
  human_test_ready: 'layout.notifications.action.human_test_ready',
  visual_confirmation_ready: 'layout.notifications.action.visual_confirmation_ready',
  human_review: 'layout.notifications.action.human_review',
  followup_pending: 'layout.notifications.action.followup_pending',
  fork_decision_pending: 'layout.notifications.action.fork_decision_pending',
  pr_review_ready: 'layout.notifications.action.pr_review_ready',
  initiative: 'layout.notifications.action.initiative',
  platform_health: 'layout.notifications.action.platform_health',
  budget_paused: 'layout.notifications.action.budget_paused',
}

/** The localized primary-action label for a notification (te()-guarded against a
 * locale that omits the key, falling back to the generic "mark read" verb). */
function actionLabel(n: Notification): string {
  const key = ACTION_KEYS[n.type]
  return te(key) ? t(key) : t('layout.notifications.action.markRead')
}

/** A notification the escalation sweep has flagged as overdue (waited past the threshold). */
function isUrgent(n: Notification): boolean {
  return n.severity === 'urgent'
}

/** True when any open notification is overdue — turns the toolbar bell red. */
const hasUrgent = computed(() => notifications.open.some(isUrgent))

/** Effective accent: urgent (red) overrides the type's base colour to convey "overdue". */
function accent(n: Notification): Accent {
  return isUrgent(n) ? 'error' : META[n.type].color
}

async function act(n: Notification) {
  busy.value = n.id
  try {
    await notifications.act(n.id)
    toast.add({
      title: t('layout.notifications.toast.acted'),
      color: 'success',
      icon: 'i-lucide-check',
    })
  } catch (e) {
    notifyError(t('layout.notifications.toast.actFailed'), e)
  } finally {
    busy.value = null
  }
}

async function dismiss(n: Notification) {
  busy.value = n.id
  try {
    await notifications.dismiss(n.id)
    toast.add({
      title: t('layout.notifications.toast.dismissed'),
      color: 'neutral',
      icon: 'i-lucide-check',
    })
  } catch (e) {
    notifyError(t('layout.notifications.toast.dismissFailed'), e)
  } finally {
    busy.value = null
  }
}

/**
 * Clicking a notification's title takes the user where they can act on it. A
 * `requirement_review` / `clarity_review` summons them straight back into the matching review
 * window (the async incorporate/re-review raised new findings or hit the cap); every other
 * type just focuses the related block on the board.
 */
function reveal(n: Notification) {
  // A `platform_health` card is deployment-scoped (no block) — send the operator to the
  // dashboard where the live aggregate numbers behind the alert live.
  if (n.type === 'platform_health') return ui.openOperatorDashboard()
  if (!n.blockId) return
  if (n.type === 'requirement_review') ui.openRequirementReview(n.blockId)
  else if (n.type === 'clarity_review') ui.openClarityReview(n.blockId)
  else if (n.type === 'decision_required') revealDecision(n)
  else if (n.type === 'human_test_ready') revealHumanTest(n)
  else if (n.type === 'visual_confirmation_ready') revealVisualConfirm(n)
  else if (n.type === 'human_review') revealHumanReview(n)
  else if (n.type === 'followup_pending') revealFollowUps(n)
  else if (n.type === 'fork_decision_pending') revealForkDecision(n)
  else if (n.type === 'pr_review_ready') revealPrReview(n)
  else if (n.type === 'initiative') ui.openInitiativeTracker(n.blockId)
  else ui.select(n.blockId)
}

/**
 * Open the gate window for a parked `human-review` gate: find the run's human-review step and
 * open it through the universal step dispatch (its archetype declares the `gate` result view,
 * where the human can request a freeform fix). Falls back to focusing the block.
 */
function revealHumanReview(n: Notification) {
  const instance = n.executionId ? execution.getInstance(n.executionId) : undefined
  const idx = instance?.steps.findIndex((s) => s.agentKind === 'human-review') ?? -1
  if (instance && idx >= 0) ui.openStepDetail(instance.id, idx)
  else if (n.blockId) ui.select(n.blockId)
}

/**
 * Open the Follow-up companion window for a run whose Coder parked on undecided items.
 * Falls back to focusing the block when the run isn't loaded.
 */
function revealFollowUps(n: Notification) {
  if (n.executionId && execution.getInstance(n.executionId)) ui.openFollowUps(n.executionId)
  else if (n.blockId) ui.select(n.blockId)
}

/**
 * Open the implementation-fork decision window for a run parked awaiting a fork choice.
 * Falls back to focusing the block when the run isn't loaded.
 */
function revealForkDecision(n: Notification) {
  if (n.executionId && execution.getInstance(n.executionId)) ui.openForkDecision(n.executionId)
  else if (n.blockId) ui.select(n.blockId)
}

/**
 * Open the PR deep-review window for a run parked awaiting a finding selection.
 * Falls back to focusing the block when the run isn't loaded.
 */
function revealPrReview(n: Notification) {
  if (n.executionId && execution.getInstance(n.executionId)) ui.openPrReview(n.executionId)
  else if (n.blockId) ui.select(n.blockId)
}

/**
 * Open the human-testing window for a parked `human-test` gate: find the run's parked
 * human-test step and open it through the universal step dispatch (its archetype declares
 * the `human-test` result view). Falls back to focusing the block.
 */
function revealHumanTest(n: Notification) {
  const instance = n.executionId ? execution.getInstance(n.executionId) : undefined
  const idx =
    instance?.steps.findIndex(
      (s) => s.agentKind === 'human-test' && s.state === 'waiting_decision',
    ) ?? -1
  if (instance && idx >= 0) ui.openStepDetail(instance.id, idx)
  else if (n.blockId) ui.select(n.blockId)
}

/**
 * Open the visual-confirmation window for a parked `visual-confirmation` gate: find the run's
 * parked step and open it through the universal step dispatch (its archetype declares the
 * `visual-confirm` result view). Falls back to focusing the block.
 */
function revealVisualConfirm(n: Notification) {
  const instance = n.executionId ? execution.getInstance(n.executionId) : undefined
  const idx =
    instance?.steps.findIndex(
      (s) => s.agentKind === 'visual-confirmation' && s.state === 'waiting_decision',
    ) ?? -1
  if (instance && idx >= 0) ui.openStepDetail(instance.id, idx)
  else if (n.blockId) ui.select(n.blockId)
}

/**
 * Open the decision surface for a parked iteration-cap run: find the run's step that is
 * waiting on a human and open it through the universal step dispatch — which routes a
 * `requirements-review` step to the review window and a companion step to its detail
 * panel (where the iteration-cap prompt lives). Falls back to focusing the block.
 */
function revealDecision(n: Notification) {
  const instance = n.executionId ? execution.getInstance(n.executionId) : undefined
  const idx = instance?.steps.findIndex((s) => s.state === 'waiting_decision') ?? -1
  if (instance && idx >= 0) ui.openStepDetail(instance.id, idx)
  else if (n.blockId) ui.select(n.blockId)
}
</script>

<template>
  <UPopover v-if="notifications.count" :content="{ align: 'end' }">
    <UButton
      data-testid="notifications-bell"
      :color="hasUrgent ? 'error' : 'warning'"
      variant="soft"
      size="sm"
      icon="i-lucide-bell"
    >
      {{ notifications.count }}
    </UButton>

    <template #content>
      <div class="max-h-[28rem] w-[min(24rem,92vw)] overflow-y-auto p-2">
        <div class="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('layout.notifications.heading') }}
        </div>
        <div
          v-for="n in notifications.open"
          :key="n.id"
          data-testid="notification-item"
          :data-notification-type="n.type"
          class="rounded-lg border p-2.5 mt-1.5"
          :class="
            isUrgent(n)
              ? 'border-error-500/60 bg-error-500/10'
              : 'border-slate-700/60 bg-slate-800/40'
          "
        >
          <div class="flex items-start gap-2">
            <UIcon
              :name="META[n.type].icon"
              :class="`mt-0.5 h-4 w-4 text-${accent(n)}-400 shrink-0`"
            />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <button
                  class="block min-w-0 flex-1 truncate text-start text-sm font-medium text-slate-200 hover:underline"
                  :title="n.title"
                  @click="reveal(n)"
                >
                  {{ n.title }}
                </button>
                <span
                  v-if="isUrgent(n)"
                  class="shrink-0 rounded bg-error-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-error-400"
                >
                  {{ t('layout.notifications.overdue') }}
                </span>
              </div>
              <p class="mt-0.5 text-[11px] leading-snug text-slate-400">{{ n.body }}</p>
              <a
                v-if="n.payload?.prUrl"
                :href="n.payload.prUrl"
                target="_blank"
                rel="noopener"
                class="mt-1 inline-flex items-center gap-1 text-[11px] text-sky-400 hover:underline"
              >
                <UIcon name="i-lucide-external-link" class="h-3 w-3" />
                {{ t('layout.notifications.openPr') }}
              </a>
              <div class="mt-2 flex items-center gap-1.5">
                <UButton
                  data-testid="notification-act"
                  :color="accent(n)"
                  variant="soft"
                  size="xs"
                  :loading="busy === n.id"
                  @click="act(n)"
                >
                  {{ actionLabel(n) }}
                </UButton>
                <UButton
                  data-testid="notification-dismiss"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :disabled="busy === n.id"
                  @click="dismiss(n)"
                >
                  {{ t('layout.notifications.dismiss') }}
                </UButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </UPopover>
</template>
