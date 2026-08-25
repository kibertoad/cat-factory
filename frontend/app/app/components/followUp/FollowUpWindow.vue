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
import type { FollowUpItem, FollowUpResolution } from '~/types/execution'
import { FOLLOW_UP_COMPANION_META } from '~/utils/catalog'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'

const execution = useExecutionStore()
const board = useBoardStore()
const followUps = useFollowUpsStore()
const access = useWorkspaceAccess()

const { t } = useI18n()

// `ResultWindowShell` owns Escape (and focus trap + scroll lock + stacking) via the shared
// overlay behaviour.
const { open, blockId, instanceId, stepIndex, close } = useResultView('follow-ups')

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const headerTitle = computed(() =>
  block.value ? t('followUp.titleWithBlock', { title: block.value.title }) : t('followUp.title'),
)
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
/**
 * Answer a question, either way.
 *
 * `answered` buys the Coder another pass to apply what you said. `closed` records the reply as a
 * RULING: the item is decided and the gate clears exactly the same, but no pass is spent and the
 * Coder is told the topic is settled so it stops re-raising it. Two buttons rather than one with a
 * toggle, because the choice is not a preference about this window: it is what the answer IS, and
 * the person typing it is the only one who knows.
 */
async function onAnswer(item: FollowUpItem, resolution: FollowUpResolution = 'answered') {
  const id = execId()
  const answer = (drafts[item.id] ?? '').trim()
  if (!id || !answer) return
  // Clear the draft only once the answer is actually recorded: clearing first would make a failed
  // send cost the typed answer, and would also leave the unsaved guard below with nothing to protect.
  await followUps
    .answerItem(id, item.id, answer, resolution)
    .then(() => {
      delete drafts[item.id]
    })
    // The store records the message; the inline error strip renders it.
    .catch(() => {})
}
async function onDismiss(item: FollowUpItem) {
  const id = execId()
  if (id) await followUps.dismissItem(id, item.id).catch(() => {})
}

/**
 * Confirm before discarding typed answers (UX-79). Each draft answers a question the Coder is
 * blocked on, is held only in this component until "Answer & send" is pressed, and the window is
 * dismissible by Escape and by a backdrop click. Auto-sending them on close is deliberately NOT
 * the fix: sending an answer DECIDES the item and re-arms the run, which is not something a stray
 * Escape may do on the user's behalf.
 */
const { requestClose } = useUnsavedGuard({
  open,
  close: () => close(),
  // Any item mid-action is about to rewrite the list; don't interrupt it with a prompt.
  saving: () => followUps.acting.size > 0,
  // Only drafts against items still awaiting a decision count: one left over from an item that has
  // since been filed or dismissed elsewhere can no longer be sent anywhere.
  snapshot: () =>
    items.value
      .filter((item) => item.status === 'pending')
      .map((item) => (drafts[item.id] ?? '').trim())
      .filter(Boolean),
})

// Exhaustive map of the item status enum → label key (literal keys keep the typed-key
// drift guard live, vs a runtime-built `followUp.status.${status}`).
const STATUS_LABEL_KEYS: Record<FollowUpItem['status'], string> = {
  pending: 'followUp.status.pending',
  filed: 'followUp.status.filed',
  queued: 'followUp.status.queued',
  answered: 'followUp.status.answered',
  closed: 'followUp.status.closed',
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
  closed: { badge: 'neutral', text: 'text-slate-300' },
  dismissed: { badge: 'neutral', text: 'text-slate-400' },
}

/** Whether a decided item carries a recorded reply to show ('answered' or 'closed'). */
function hasRecordedAnswer(item: FollowUpItem): boolean {
  return (item.status === 'answered' || item.status === 'closed') && !!item.answer
}
</script>

<template>
  <ResultWindowShell
    :open="open"
    :icon="FOLLOW_UP_COMPANION_META.icon"
    icon-class="bg-pink-500/15 text-pink-300"
    :title="headerTitle"
    :subtitle="t('followUp.subtitle')"
    width="3xl"
    @close="requestClose"
  >
    <template #header-extras>
      <UBadge :color="pendingCount > 0 ? 'warning' : 'success'" variant="subtle" size="sm">
        {{
          pendingCount > 0
            ? t('followUp.badge.toDecide', { count: pendingCount }, pendingCount)
            : t('followUp.badge.allDecided')
        }}
      </UBadge>
    </template>

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
              <p v-if="hasRecordedAnswer(item)" class="mt-1 text-[11px] text-slate-300">
                <span class="text-slate-500">
                  {{
                    item.status === 'closed' ? t('followUp.yourRuling') : t('followUp.yourAnswer')
                  }}
                </span>
                {{ item.answer }}
              </p>
              <!-- A decision that was made and then thrown away when the budget ran out. It must
                   not read like one the Coder acted on. -->
              <p v-if="item.sendBackDropped" class="mt-1 text-[11px] text-amber-300">
                {{ t('followUp.sendBackDropped') }}
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
                  <!-- Wraps, like the follow-up row below: three buttons whose labels are two
                       words each in English are one long line in most of the other locales, and
                       the result window is a narrow panel. -->
                  <div class="flex flex-wrap items-center gap-2">
                    <UButton
                      size="xs"
                      color="primary"
                      :loading="followUps.isActing(item.id)"
                      :disabled="!(drafts[item.id] ?? '').trim() || !access.canExecuteRuns.value"
                      :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
                      @click="onAnswer(item)"
                    >
                      {{ t('followUp.actions.answerAndSend') }}
                    </UButton>
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="subtle"
                      :loading="followUps.isActing(item.id)"
                      :disabled="!(drafts[item.id] ?? '').trim() || !access.canExecuteRuns.value"
                      :title="
                        access.canExecuteRuns.value
                          ? t('followUp.actions.answerAndCloseHint')
                          : t('access.noRunExecute')
                      "
                      @click="onAnswer(item, 'closed')"
                    >
                      {{ t('followUp.actions.answerAndClose') }}
                    </UButton>
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :loading="followUps.isActing(item.id)"
                      :disabled="!access.canExecuteRuns.value"
                      :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
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
      <span v-if="maxLoops > 0">{{ t('followUp.footer.loops', { loops, max: maxLoops }) }}</span>
    </footer>
  </ResultWindowShell>
</template>
