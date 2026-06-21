<script setup lang="ts">
import type { Notification } from '~/types/domain'

// The board's notification inbox: a bell with an open-count badge that opens a
// panel of human-actionable items (a PR awaiting a merge decision, a completed
// pipeline awaiting confirmation, CI that gave up). Each item can be acted on
// (merge / confirm / retry) or dismissed. Hydrated from the snapshot and patched
// live via the `notification` WorkspaceEvent.

const notifications = useNotificationsStore()
const ui = useUiStore()

const busy = ref<string | null>(null)

/** Per-type display metadata (icon, colour, primary-action label). */
type Accent = 'warning' | 'primary' | 'error'
const META: Record<Notification['type'], { icon: string; color: Accent; action: string }> = {
  merge_review: { icon: 'i-lucide-git-pull-request-arrow', color: 'warning', action: 'Merge' },
  pipeline_complete: { icon: 'i-lucide-circle-check', color: 'primary', action: 'Confirm & merge' },
  ci_failed: { icon: 'i-lucide-triangle-alert', color: 'error', action: 'Retry run' },
  // Informational: clicking the title reveals the task to review; "act" just marks
  // it read (the server performs no side-effect for this type).
  requirement_review: { icon: 'i-lucide-clipboard-list', color: 'primary', action: 'Mark read' },
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

/** Focus the related block on the board when a notification is clicked. */
function reveal(n: Notification) {
  if (n.blockId) ui.select(n.blockId)
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
