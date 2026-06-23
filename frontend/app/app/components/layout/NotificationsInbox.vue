<script setup lang="ts">
import type { Notification } from '~/types/domain'

// The board's notification inbox: a bell with an open-count badge that opens a
// panel of human-actionable items (a PR awaiting a merge decision, a completed
// pipeline awaiting confirmation, CI that gave up). Each item can be acted on
// (merge / confirm / retry) or dismissed. Hydrated from the snapshot and patched
// live via the `notification` WorkspaceEvent.

const notifications = useNotificationsStore()
const ui = useUiStore()
const execution = useExecutionStore()

const busy = ref<string | null>(null)

/** Per-type display metadata (icon, colour, primary-action label). */
type Accent = 'warning' | 'primary' | 'error'
const META: Record<Notification['type'], { icon: string; color: Accent; action: string }> = {
  merge_review: { icon: 'i-lucide-git-pull-request-arrow', color: 'warning', action: 'Merge' },
  pipeline_complete: { icon: 'i-lucide-circle-check', color: 'primary', action: 'Confirm & merge' },
  ci_failed: { icon: 'i-lucide-triangle-alert', color: 'error', action: 'Retry run' },
  test_failed: { icon: 'i-lucide-flask-conical', color: 'error', action: 'Retry run' },
  // Clicking the title opens the review window for the task (see `reveal`); "act" just marks
  // it read (the server performs no side-effect for this type).
  requirement_review: { icon: 'i-lucide-clipboard-list', color: 'primary', action: 'Mark read' },
  // Clicking the title opens the clarity review window for the task (see `reveal`); "act"
  // just marks it read (the server performs no side-effect for this type).
  clarity_review: { icon: 'i-lucide-bug', color: 'primary', action: 'Mark read' },
  // A post-release Datadog regression the on-call agent investigated. The human decides
  // whether to revert (in GitHub via the PR link) or acknowledge; "act" marks it handled.
  release_regression: { icon: 'i-lucide-activity', color: 'error', action: 'Acknowledge' },
  // Clicking the title opens the parked step's decision surface (companion → step detail
  // with the iteration-cap prompt; requirements → the review window); "act" just marks it
  // read (the decision itself is resolved in that surface, not here).
  decision_required: { icon: 'i-lucide-circle-help', color: 'warning', action: 'Mark read' },
}

async function act(n: Notification) {
  busy.value = n.id
  try {
    await notifications.act(n.id)
  } finally {
    busy.value = null
  }
}

async function dismiss(n: Notification) {
  busy.value = n.id
  try {
    await notifications.dismiss(n.id)
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
  if (!n.blockId) return
  if (n.type === 'requirement_review') ui.openRequirementReview(n.blockId)
  else if (n.type === 'clarity_review') ui.openClarityReview(n.blockId)
  else if (n.type === 'decision_required') revealDecision(n)
  else ui.select(n.blockId)
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
    <UButton color="warning" variant="soft" size="sm" icon="i-lucide-bell">
      {{ notifications.count }}
    </UButton>

    <template #content>
      <div class="max-h-[28rem] w-96 overflow-y-auto p-2">
        <div class="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Needs your attention
        </div>
        <div
          v-for="n in notifications.open"
          :key="n.id"
          class="rounded-lg border border-slate-700/60 bg-slate-800/40 p-2.5 mt-1.5"
        >
          <div class="flex items-start gap-2">
            <UIcon
              :name="META[n.type].icon"
              :class="`mt-0.5 h-4 w-4 text-${META[n.type].color}-400 shrink-0`"
            />
            <div class="min-w-0 flex-1">
              <button
                class="block w-full truncate text-left text-sm font-medium text-slate-200 hover:underline"
                :title="n.title"
                @click="reveal(n)"
              >
                {{ n.title }}
              </button>
              <p class="mt-0.5 text-[11px] leading-snug text-slate-400">{{ n.body }}</p>
              <a
                v-if="n.payload?.prUrl"
                :href="n.payload.prUrl"
                target="_blank"
                rel="noopener"
                class="mt-1 inline-flex items-center gap-1 text-[11px] text-sky-400 hover:underline"
              >
                <UIcon name="i-lucide-external-link" class="h-3 w-3" /> Open PR
              </a>
              <div class="mt-2 flex items-center gap-1.5">
                <UButton
                  :color="META[n.type].color"
                  variant="soft"
                  size="xs"
                  :loading="busy === n.id"
                  @click="act(n)"
                >
                  {{ META[n.type].action }}
                </UButton>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :disabled="busy === n.id"
                  @click="dismiss(n)"
                >
                  Dismiss
                </UButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </UPopover>
</template>
