<script setup lang="ts">
// Follow-up companion window — the dedicated surface for the future-looking Coder's
// surfaced items, opened via the universal result-view host (`ui.openFollowUps`). It reads
// the live items straight off the run's Coder step (`step.followUps`, kept fresh by the
// execution stream — a synchronous window, no `onOpen` loader) and lets a human decide each:
// file a follow-up as a tracker issue, send it back to the Coder, answer a question, or
// dismiss it. The pipeline's following steps stay blocked until every item is decided.
import { computed, reactive } from 'vue'
import { useResultView } from '~/composables/useResultView'
import { useExecutionStore } from '~/stores/execution'
import { useBoardStore } from '~/stores/board'
import { useFollowUpsStore } from '~/stores/followUps'
import type { FollowUpItem } from '~/types/execution'
import { FOLLOW_UP_COMPANION_META } from '~/utils/catalog'

const execution = useExecutionStore()
const board = useBoardStore()
const followUps = useFollowUpsStore()
const access = useWorkspaceAccess()

const { t } = useI18n()

const { open, blockId, instanceId, stepIndex, close } = useResultView('follow-ups')

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const instance = computed(() =>
  instanceId.value === null ? null : (execution.getInstance(instanceId.value) ?? null),
)
const step = computed(() => {
  if (instance.value === null || stepIndex.value === null) return null
  return instance.value.steps[stepIndex.value] ?? null
})
const items = computed<FollowUpItem[]>(() => step.value?.followUps?.items ?? [])
const pendingCount = computed(() => items.value.filter((i) => i.status === 'pending').length)
const loops = computed(() => step.value?.followUps?.loops ?? 0)
const maxLoops = computed(() => step.value?.followUps?.maxLoops ?? 0)

// Draft answers per question item (keyed by item id), so typing doesn't clobber on re-render.
const drafts = reactive<Record<string, string>>({})

function execId(): string | null {
  return instanceId.value
}

async function onFile(item: FollowUpItem) {
  const id = execId()
  if (id) await followUps.fileItem(id, item.id).catch(() => {})
}
async function onQueue(item: FollowUpItem) {
  const id = execId()
  if (id) await followUps.queueItem(id, item.id).catch(() => {})
}
async function onAnswer(item: FollowUpItem) {
  const id = execId()
  const answer = (drafts[item.id] ?? '').trim()
  if (id && answer) await followUps.answerItem(id, item.id, answer).catch(() => {})
}
async function onDismiss(item: FollowUpItem) {
  const id = execId()
  if (id) await followUps.dismissItem(id, item.id).catch(() => {})
}

// Exhaustive map of the item status enum → label key (literal keys keep the typed-key
// drift guard live, vs a runtime-built `followUp.status.${status}`).
const STATUS_LABEL_KEYS: Record<FollowUpItem['status'], string> = {
  pending: 'followUp.status.pending',
  filed: 'followUp.status.filed',
  queued: 'followUp.status.queued',
  answered: 'followUp.status.answered',
  dismissed: 'followUp.status.dismissed',
}

const STATUS_META: Record<
  FollowUpItem['status'],
  { badge: 'neutral' | 'info' | 'success' | 'warning'; text: string }
> = {
  pending: { badge: 'warning', text: 'text-amber-300' },
  filed: { badge: 'success', text: 'text-emerald-300' },
  queued: { badge: 'info', text: 'text-sky-300' },
  answered: { badge: 'info', text: 'text-sky-300' },
  dismissed: { badge: 'neutral', text: 'text-slate-400' },
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex max-h-[100dvh] items-stretch justify-center bg-slate-950/70 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="m-4 flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
        role="dialog"
        aria-modal="true"
      >
        <!-- Header -->
        <header class="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <span
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-pink-500/15 text-pink-300"
          >
            <UIcon :name="FOLLOW_UP_COMPANION_META.icon" class="h-4 w-4" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-sm font-semibold text-slate-100">
              {{
                block ? t('followUp.titleWithBlock', { title: block.title }) : t('followUp.title')
              }}
            </h2>
            <p class="truncate text-[11px] text-slate-400">
              {{ t('followUp.subtitle') }}
            </p>
          </div>
          <UBadge :color="pendingCount > 0 ? 'warning' : 'success'" variant="subtle" size="sm">
            {{
              pendingCount > 0
                ? t('followUp.badge.toDecide', { count: pendingCount }, pendingCount)
                : t('followUp.badge.allDecided')
            }}
          </UBadge>
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            @click="close"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <!-- Empty -->
          <div
            v-if="items.length === 0"
            class="flex h-full flex-col items-center justify-center gap-2 py-10 text-center text-slate-400"
          >
            <UIcon :name="FOLLOW_UP_COMPANION_META.icon" class="h-8 w-8 opacity-40" />
            <p class="text-sm">{{ t('followUp.empty.title') }}</p>
            <p class="max-w-sm text-[11px] text-slate-500">
              {{ t('followUp.empty.hint') }}
            </p>
          </div>

          <div v-else class="space-y-3">
            <p
              v-if="followUps.error"
              class="rounded-md bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300"
            >
              {{ followUps.error }}
            </p>

            <article
              v-for="item in items"
              :key="item.id"
              class="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3"
              :class="item.status === 'pending' ? 'border-amber-500/40' : ''"
            >
              <div class="flex items-start gap-2">
                <UIcon
                  :name="item.kind === 'question' ? 'i-lucide-circle-help' : 'i-lucide-compass'"
                  class="mt-0.5 h-4 w-4 shrink-0"
                  :class="item.kind === 'question' ? 'text-sky-300' : 'text-pink-300'"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <h3 class="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-100">
                      {{ item.title }}
                    </h3>
                    <UBadge :color="STATUS_META[item.status].badge" variant="subtle" size="sm">
                      {{ t(STATUS_LABEL_KEYS[item.status]) }}
                    </UBadge>
                  </div>
                  <p v-if="item.detail" class="mt-1 whitespace-pre-wrap text-[12px] text-slate-300">
                    {{ item.detail }}
                  </p>
                  <p v-if="item.suggestedAction" class="mt-1 text-[11px] text-slate-400">
                    <span class="text-slate-500">{{ t('followUp.suggested') }}</span>
                    {{ item.suggestedAction }}
                  </p>
                  <p v-if="item.status === 'filed' && item.ticketUrl" class="mt-1 text-[11px]">
                    <a
                      :href="item.ticketUrl"
                      target="_blank"
                      rel="noopener"
                      class="text-emerald-300 hover:underline"
                    >
                      {{ item.ticketExternalId ?? t('followUp.viewIssue') }}
                    </a>
                  </p>
                  <p
                    v-if="item.status === 'answered' && item.answer"
                    class="mt-1 text-[11px] text-slate-300"
                  >
                    <span class="text-slate-500">{{ t('followUp.yourAnswer') }}</span>
                    {{ item.answer }}
                  </p>

                  <!-- Actions (only while the item is still undecided) -->
                  <div v-if="item.status === 'pending'" class="mt-2.5">
                    <!-- A question: answer it -->
                    <div v-if="item.kind === 'question'" class="space-y-2">
                      <textarea
                        v-model="drafts[item.id]"
                        rows="2"
                        :placeholder="t('followUp.answerPlaceholder')"
                        class="w-full resize-y rounded-md border border-slate-700 bg-slate-950/60 px-2.5 py-1.5 text-[12px] text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"
                      />
                      <div class="flex items-center gap-2">
                        <UButton
                          size="xs"
                          color="primary"
                          :loading="followUps.isActing(item.id)"
                          :disabled="
                            !(drafts[item.id] ?? '').trim() || !access.canExecuteRuns.value
                          "
                          :title="
                            access.canExecuteRuns.value ? undefined : t('access.noRunExecute')
                          "
                          @click="onAnswer(item)"
                        >
                          {{ t('followUp.actions.answerAndSend') }}
                        </UButton>
                        <UButton
                          size="xs"
                          color="neutral"
                          variant="ghost"
                          :loading="followUps.isActing(item.id)"
                          :disabled="!access.canExecuteRuns.value"
                          :title="
                            access.canExecuteRuns.value ? undefined : t('access.noRunExecute')
                          "
                          @click="onDismiss(item)"
                        >
                          {{ t('followUp.actions.dismiss') }}
                        </UButton>
                      </div>
                    </div>

                    <!-- A follow-up: file / send back / dismiss -->
                    <div v-else class="flex flex-wrap items-center gap-2">
                      <UButton
                        size="xs"
                        color="primary"
                        icon="i-lucide-ticket"
                        :loading="followUps.isActing(item.id)"
                        :disabled="!access.canExecuteRuns.value"
                        :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
                        @click="onFile(item)"
                      >
                        {{ t('followUp.actions.fileAsIssue') }}
                      </UButton>
                      <UButton
                        size="xs"
                        color="info"
                        variant="soft"
                        icon="i-lucide-corner-up-left"
                        :loading="followUps.isActing(item.id)"
                        :disabled="!access.canExecuteRuns.value"
                        :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
                        @click="onQueue(item)"
                      >
                        {{ t('followUp.actions.sendToCoder') }}
                      </UButton>
                      <UButton
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        :loading="followUps.isActing(item.id)"
                        @click="onDismiss(item)"
                      >
                        {{ t('followUp.actions.dismiss') }}
                      </UButton>
                    </div>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </div>

        <footer
          class="flex items-center justify-between border-t border-slate-800 px-5 py-2.5 text-[11px] text-slate-400"
        >
          <span>
            {{
              t(
                'followUp.footer.summary',
                { count: items.length, undecided: pendingCount },
                items.length,
              )
            }}
          </span>
          <span v-if="maxLoops > 0">{{
            t('followUp.footer.loops', { loops, max: maxLoops })
          }}</span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
