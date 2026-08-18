<script setup lang="ts">
// Opt-in review-debt friction dialog. Shown when a task-create request is refused by the friction
// gate (a `review_debt_warn` / `review_debt_blocked` 409). It lists exactly which tasks are waiting
// on human review (worst first), each deep-linking to its block so "go review instead" is one
// click. The soft `warn` tier offers a secondary "Create anyway" (retries with the acknowledge
// flag); the hard `blocked` tier does not. Driven by `ui.reviewFrictionContext`, mounted in
// pages/index.vue. See backend/docs/review-debt-friction.md.
import { computed } from 'vue'

const { t } = useI18n()
const ui = useUiStore()

const ctx = computed(() => ui.reviewFrictionContext)

// True while the opener's create is actually in flight. Read through the context's getter inside a
// computed so it tracks the opener's own `saving` ref (UX-78): the context object itself is
// captured once at open, so a copied boolean would never update.
//
// While it holds, EVERY way out is closed, not just the buttons. Gating the two actions and leaving
// Close, Escape and the backdrop live was the worse half of the asymmetry: it locked the safe exit
// (go review the waiting tasks) and left open the one that tears the dialog down mid-create, so the
// user could not tell whether a task had been filed.
const pending = computed(() => ctx.value?.pending?.() ?? false)

const open = computed({
  get: () => ctx.value !== null,
  set: (v: boolean) => {
    // Refuse a USER dismissal while the create is in flight (see `pending`). The opener still closes
    // this dialog directly through the store on success, so only the human's exits are gated.
    if (!v && !pending.value) ui.closeReviewFriction()
  },
})

const title = computed(() =>
  ctx.value?.kind === 'blocked'
    ? t('errors.reviewFriction.blockedTitle')
    : t('errors.reviewFriction.warnTitle'),
)

const body = computed(() => {
  const c = ctx.value
  if (!c) return ''
  if (c.kind === 'warn') return t('errors.reviewFriction.warnBody', { count: c.debt.length })
  if (c.reason === 'stuck')
    return t('errors.reviewFriction.blockedStuckBody', { minutes: c.threshold ?? 0 })
  return t('errors.reviewFriction.blockedCountBody', {
    count: c.debt.length,
    threshold: c.threshold ?? 0,
  })
})

/** Deep-link to a waiting task's block and dismiss the whole friction flow. */
function goToBlock(blockId: string) {
  if (blockId) ui.select(blockId)
  ui.closeReviewFriction()
  ui.closeAddTask()
}

function goReview() {
  const first = ctx.value?.debt[0]
  if (first) goToBlock(first.blockId)
  else {
    ui.closeReviewFriction()
    ui.closeAddTask()
  }
}

function createAnyway() {
  if (pending.value) return
  ctx.value?.onConfirm?.()
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :dismissible="!pending"
    :close="{ disabled: pending }"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <div v-if="ctx" class="space-y-5">
        <p class="text-sm text-slate-300">{{ body }}</p>

        <div class="rounded-lg border border-slate-700 bg-slate-900/50 p-2">
          <p class="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {{ t('errors.reviewFriction.waitingHeading') }}
          </p>
          <ul class="space-y-1">
            <li v-for="item in ctx.debt" :key="item.blockId">
              <button
                type="button"
                class="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-800/60 disabled:opacity-50"
                :disabled="pending"
                @click="goToBlock(item.blockId)"
              >
                <span class="truncate text-slate-200">
                  {{ item.title || t('errors.reviewFriction.untitled') }}
                </span>
                <span class="shrink-0 text-[12px] text-slate-500">
                  {{ t('errors.reviewFriction.waiting', { minutes: item.waitingMinutes }) }}
                </span>
              </button>
            </li>
          </ul>
        </div>

        <div class="flex flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            :disabled="pending"
            data-testid="review-friction-close"
            @click="
              () => {
                open = false
              }
            "
          >
            {{ t('errors.reviewFriction.close') }}
          </UButton>
          <UButton
            v-if="ctx.onConfirm"
            color="neutral"
            variant="subtle"
            size="sm"
            :loading="pending"
            :disabled="pending"
            data-testid="review-friction-create-anyway"
            @click="createAnyway"
          >
            {{ t('errors.reviewFriction.createAnyway') }}
          </UButton>
          <UButton
            color="primary"
            size="sm"
            icon="i-lucide-list-checks"
            :disabled="pending"
            @click="goReview"
          >
            {{ t('errors.reviewFriction.goReview') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
