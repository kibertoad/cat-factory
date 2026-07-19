<script setup lang="ts">
// Brainstorm window — the dedicated surface for the `requirements-brainstorm` /
// `architecture-brainstorm` gate steps (opened via the universal result-view host; the two
// stages share this one window). The agent PROPOSES options with explicit trade-offs; the
// human picks the relevant ones, steers them, and dismisses the rest, then asks to incorporate.
// Incorporation + the re-run happen ASYNCHRONOUSLY in the durable driver: the window closes and
// the user returns to the board, summoned back (a notification) only if the re-run raises new
// options or hits the iteration cap. The converged direction — not the original description — is
// what the downstream stage (the requirements review / the architect) consumes.
import IterationCapPrompt from '~/components/pipeline/IterationCapPrompt.vue'
import ResultWindowShell from '~/components/panels/ResultWindowShell.vue'
import { parseOutputOutline } from '~/utils/agentOutput'
import type {
  BrainstormItem,
  BrainstormItemStatus,
  BrainstormSession,
  BrainstormStage,
  ReviewItemCategory,
  ReviewItemSeverity,
  ReviewItemStatus,
} from '~/types/brainstorm'

const board = useBoardStore()
const brainstorm = useBrainstormStore()
const ui = useUiStore()
const toast = useToast()
const { t } = useI18n()
const access = useWorkspaceAccess()

const drafts = ref<Record<string, string>>({})
const redoComment = ref('')
const showRedo = ref(false)

const { open, blockId, stage, close } = useResultView('brainstorm', {
  // `onOpen` fires synchronously from `useResultView`'s immediate watch, BEFORE the `stage`
  // const below is initialised — so read the stage straight off the store here (referencing
  // `stage.value` would hit its temporal dead zone and throw on every open).
  onOpen: (id) => {
    drafts.value = {}
    redoComment.value = ''
    showRedo.value = false
    const openStage = ui.resultView?.stage
    if (openStage) void brainstorm.load(id, openStage)
  },
})
const activeStage = computed<BrainstormStage>(() => stage.value ?? 'requirements')
const isArchitecture = computed(() => activeStage.value === 'architecture')
const subjectNoun = computed(() =>
  isArchitecture.value
    ? t('brainstorm.subjectNoun.architecture')
    : t('brainstorm.subjectNoun.requirements'),
)
const docNoun = computed(() =>
  isArchitecture.value
    ? t('brainstorm.docNoun.architecture')
    : t('brainstorm.docNoun.requirements'),
)

const block = computed(() => (blockId.value ? board.getBlock(blockId.value) : undefined))
const session = computed<BrainstormSession | null>(() =>
  blockId.value ? brainstorm.sessionFor(blockId.value, activeStage.value) : null,
)
const busy = computed(() =>
  blockId.value ? brainstorm.isRunning(blockId.value, activeStage.value) : false,
)
const loading = computed(() =>
  blockId.value ? brainstorm.isLoading(blockId.value, activeStage.value) : false,
)
const reworking = computed(() =>
  session.value ? brainstorm.isIncorporating(session.value.id) : false,
)
const acting = ref(false)

const SEVERITY_RANK: Record<ReviewItemSeverity, number> = { high: 0, medium: 1, low: 2 }
const sortedItems = computed<BrainstormItem[]>(() => {
  if (!session.value) return []
  return [...session.value.items].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  )
})

const openCount = computed(() => (session.value ? brainstorm.openCount(session.value) : 0))
const answeredCount = computed(() => (session.value ? brainstorm.answeredCount(session.value) : 0))
const status = computed(() => session.value?.status ?? null)
const merged = computed(() => status.value === 'merged')
const exceeded = computed(() => status.value === 'exceeded')
const incorporated = computed(() => status.value === 'incorporated')
const incorporating = computed(() => status.value === 'incorporating')
const reReviewing = computed(() => status.value === 'reviewing')
const working = computed(() => incorporating.value || reReviewing.value)
const frozen = computed(() => incorporated.value || working.value)
const canIncorporate = computed(() => !!session.value && brainstorm.canIncorporate(session.value))
const canProceed = computed(() => !!session.value && brainstorm.canProceed(session.value))
const iteration = computed(() => session.value?.iteration ?? 1)
const maxIterations = computed(() => session.value?.maxIterations ?? 1)

// The converged direction rendered as collapsible markdown (same reader the prose review
// window uses), shown once the companion has produced one.
const outline = computed(() =>
  session.value?.convergedDirection ? parseOutputOutline(session.value.convergedDirection) : null,
)
const collapsed = ref<Record<string, boolean>>({})
function toggle(id: string) {
  collapsed.value = { ...collapsed.value, [id]: !collapsed.value[id] }
}

const SEVERITY_COLOR = {
  high: 'error',
  medium: 'warning',
  low: 'neutral',
} as const satisfies Record<ReviewItemSeverity, string>
const CATEGORY_ICON: Record<ReviewItemCategory, string> = {
  gap: 'i-lucide-puzzle',
  clarification: 'i-lucide-help-circle',
  assumption: 'i-lucide-lightbulb',
  risk: 'i-lucide-shield-alert',
  question: 'i-lucide-message-circle-question',
}
const STATUS_COLOR = {
  open: 'warning',
  answered: 'info',
  resolved: 'success',
  dismissed: 'neutral',
  // Brainstorm doesn't request Requirement-Writer recommendations, but the item-status type
  // is shared with the requirements review, so the map must be exhaustive.
  recommend_requested: 'primary',
} as const satisfies Record<ReviewItemStatus, string>

// Exhaustive enum→label maps of literal keys (keeps the typed-key drift guard live vs a
// runtime-built `brainstorm.severity.${value}`).
const SEVERITY_LABELS: Record<ReviewItemSeverity, string> = {
  low: 'brainstorm.severity.low',
  medium: 'brainstorm.severity.medium',
  high: 'brainstorm.severity.high',
}
const CATEGORY_LABELS: Record<ReviewItemCategory, string> = {
  gap: 'brainstorm.category.gap',
  clarification: 'brainstorm.category.clarification',
  assumption: 'brainstorm.category.assumption',
  risk: 'brainstorm.category.risk',
  question: 'brainstorm.category.question',
}
const STATUS_LABELS: Record<ReviewItemStatus, string> = {
  open: 'brainstorm.itemStatus.open',
  answered: 'brainstorm.itemStatus.answered',
  resolved: 'brainstorm.itemStatus.resolved',
  dismissed: 'brainstorm.itemStatus.dismissed',
  recommend_requested: 'brainstorm.itemStatus.recommend_requested',
}

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

async function submitReply(item: BrainstormItem) {
  if (!session.value) return
  const text = (drafts.value[item.id] ?? '').trim()
  if (!text) return
  try {
    await brainstorm.reply(session.value, item.id, text)
    drafts.value = { ...drafts.value, [item.id]: '' }
  } catch (e) {
    notifyError(t('brainstorm.toast.saveChoiceError'), e)
  }
}

async function setStatus(item: BrainstormItem, itemStatus: BrainstormItemStatus) {
  if (!session.value) return
  try {
    await brainstorm.setItemStatus(session.value, item.id, itemStatus)
  } catch (e) {
    notifyError(t('brainstorm.toast.updateOptionError'), e)
  }
}

async function incorporate(feedback?: string) {
  if (!session.value || !blockId.value) return
  try {
    await brainstorm.incorporate(session.value, feedback)
  } catch (e) {
    notifyError(t('brainstorm.toast.incorporateError'), e)
    return
  }
  redoComment.value = ''
  showRedo.value = false
  toast.add({
    title: t('brainstorm.toast.draftingTitle', { doc: docNoun.value }),
    description: t('brainstorm.toast.draftingDescription'),
    icon: 'i-lucide-wand-sparkles',
  })
  close()
}

async function reReview() {
  if (!blockId.value) return
  try {
    const updated = await brainstorm.reReview(blockId.value, activeStage.value)
    const newCount = brainstorm.openCount(updated)
    toast.add({
      title:
        updated.status === 'incorporated'
          ? t('brainstorm.toast.reReviewSettled')
          : updated.status === 'exceeded'
            ? t('brainstorm.toast.reReviewExceeded')
            : t('brainstorm.toast.reReviewNewOptions', { count: newCount }, newCount),
      icon: 'i-lucide-sparkles',
    })
  } catch (e) {
    notifyError(t('brainstorm.toast.reReviewError'), e)
  }
}

async function proceed() {
  if (!blockId.value) return
  acting.value = true
  try {
    await brainstorm.proceed(blockId.value, activeStage.value)
    toast.add({ title: t('brainstorm.toast.proceeding'), icon: 'i-lucide-arrow-right' })
  } catch (e) {
    notifyError(t('brainstorm.toast.proceedError'), e)
  } finally {
    acting.value = false
  }
}

async function resolveExceeded(choice: 'extra-round' | 'proceed' | 'stop-reset') {
  if (!blockId.value) return
  acting.value = true
  try {
    await brainstorm.resolveExceeded(blockId.value, activeStage.value, choice)
    if (choice === 'stop-reset') {
      toast.add({ title: t('brainstorm.toast.taskReset'), icon: 'i-lucide-undo' })
      close()
    } else if (choice === 'proceed') {
      toast.add({ title: t('brainstorm.toast.proceeding'), icon: 'i-lucide-arrow-right' })
    } else {
      toast.add({ title: t('brainstorm.toast.extraRoundGranted'), icon: 'i-lucide-rotate-cw' })
    }
  } catch (e) {
    notifyError(t('brainstorm.toast.resolveError'), e)
  } finally {
    acting.value = false
  }
}
</script>

<template>
  <ResultWindowShell
    :open="open"
    :icon="isArchitecture ? 'i-lucide-drafting-compass' : 'i-lucide-lightbulb'"
    icon-class="bg-amber-500/15 text-amber-300"
    :title="
      isArchitecture ? t('brainstorm.title.architecture') : t('brainstorm.title.requirements')
    "
    :subtitle="block?.title"
    variant="centered"
    width="5xl"
    @close="close"
  >
    <template v-if="session" #header-extras>
      <UBadge color="neutral" variant="subtle" size="sm">
        {{ t('brainstorm.iteration', { current: iteration, max: maxIterations }) }}
      </UBadge>
    </template>

    <div class="flex min-h-0 flex-1">
      <!-- main column -->
      <div class="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        <p class="mb-4 text-sm text-slate-400">
          <i18n-t keypath="brainstorm.intro" tag="span" scope="global">
            <template #subject>{{ subjectNoun }}</template>
            <template #doc>{{ docNoun }}</template>
            <template #choose>
              <span class="text-slate-300">{{ t('brainstorm.introChoose') }}</span>
            </template>
            <template #dismiss>
              <span class="text-slate-300">{{ t('brainstorm.introDismiss') }}</span>
            </template>
          </i18n-t>
        </p>

        <!-- empty state -->
        <div
          v-if="!session && !busy && !loading"
          class="rounded-lg border border-dashed border-slate-700 p-8 text-center text-sm text-slate-500"
        >
          {{ t('brainstorm.empty') }}
        </div>

        <!-- working state (initial fetch on open, or an agent pass running) -->
        <div
          v-else-if="(busy || loading) && !session"
          class="flex items-center justify-center gap-2 p-8 text-sm text-slate-400"
        >
          <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
          {{ loading && !busy ? t('brainstorm.loading') : t('brainstorm.generating') }}
        </div>

        <template v-else-if="session">
          <!-- converged -->
          <div
            v-if="incorporated"
            class="mb-4 flex items-center gap-2 rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-4 text-sm text-emerald-300"
          >
            <UIcon name="i-lucide-circle-check" class="h-5 w-5 shrink-0" />
            {{ t('brainstorm.settledBanner', { doc: docNoun }) }}
          </div>

          <!-- iteration cap hit -->
          <IterationCapPrompt
            v-else-if="exceeded"
            class="mb-4"
            :heading="t('brainstorm.exceeded.heading', { max: maxIterations })"
            :detail="t('brainstorm.exceeded.detail')"
            :loading="acting"
            @resolve="resolveExceeded"
          />

          <!-- working: the async cycle is running in the driver -->
          <div
            v-else-if="working"
            class="mb-4 flex items-center gap-2 rounded-lg border border-amber-900/60 bg-amber-950/30 p-4 text-sm text-amber-200"
          >
            <UIcon name="i-lucide-loader-circle" class="h-5 w-5 shrink-0 animate-spin" />
            <span v-if="incorporating">
              {{ t('brainstorm.working.incorporating', { doc: docNoun }) }}
            </span>
            <span v-else>
              {{ t('brainstorm.working.reReviewing') }}
            </span>
          </div>

          <!-- options to react to -->
          <div v-if="session.items.length" class="flex flex-col gap-3">
            <div
              v-for="item in sortedItems"
              :key="item.id"
              class="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
              :class="{ 'opacity-60': item.status === 'dismissed' }"
            >
              <div class="flex items-start gap-2">
                <UIcon
                  :name="CATEGORY_ICON[item.category]"
                  class="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="text-sm font-medium text-white">{{ item.title }}</span>
                    <UBadge size="xs" variant="subtle" :color="SEVERITY_COLOR[item.severity]">
                      {{ t(SEVERITY_LABELS[item.severity]) }}
                    </UBadge>
                    <UBadge size="xs" variant="outline" color="neutral">
                      {{ t(CATEGORY_LABELS[item.category]) }}
                    </UBadge>
                    <UBadge
                      size="xs"
                      variant="soft"
                      :color="STATUS_COLOR[item.status]"
                      class="ms-auto"
                    >
                      {{ t(STATUS_LABELS[item.status]) }}
                    </UBadge>
                  </div>
                  <p class="mt-1 whitespace-pre-line text-sm text-slate-400">
                    {{ item.detail }}
                  </p>

                  <!-- recorded choice -->
                  <div
                    v-if="item.reply"
                    class="mt-2 rounded-md border-s-2 border-slate-700 bg-slate-950/40 px-3 py-1.5 text-sm text-slate-300"
                  >
                    <span class="text-[10px] uppercase tracking-wide text-slate-500">
                      {{ t('brainstorm.yourChoice') }}
                    </span>
                    <p class="whitespace-pre-line">{{ item.reply }}</p>
                  </div>

                  <!-- react: choose (relevant) or dismiss (irrelevant) -->
                  <template v-if="item.status === 'open' || item.status === 'answered'">
                    <UTextarea
                      v-model="drafts[item.id]"
                      :rows="2"
                      autoresize
                      size="sm"
                      class="mt-2 w-full"
                      :placeholder="
                        item.reply
                          ? t('brainstorm.replyPlaceholder.refine')
                          : t('brainstorm.replyPlaceholder.choose')
                      "
                      :disabled="frozen"
                    />
                    <div class="mt-2 flex flex-wrap items-center gap-2">
                      <UButton
                        color="primary"
                        variant="soft"
                        size="xs"
                        icon="i-lucide-corner-down-left"
                        :disabled="
                          !(drafts[item.id] ?? '').trim() || frozen || !access.canExecuteRuns.value
                        "
                        :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
                        @click="submitReply(item)"
                      >
                        {{ t('brainstorm.saveChoice') }}
                      </UButton>
                      <UButton
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        icon="i-lucide-x"
                        :disabled="frozen || !access.canExecuteRuns.value"
                        :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
                        @click="setStatus(item, 'dismissed')"
                      >
                        {{ t('brainstorm.dismiss') }}
                      </UButton>
                    </div>
                  </template>

                  <!-- reopen a dismissed option -->
                  <div v-else-if="item.status === 'dismissed'" class="mt-2">
                    <UButton
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      icon="i-lucide-rotate-ccw"
                      :disabled="frozen || !access.canExecuteRuns.value"
                      :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
                      @click="setStatus(item, 'open')"
                    >
                      {{ t('brainstorm.reopen') }}
                    </UButton>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- converged document: the standard-format direction -->
          <section v-if="outline" class="mt-6 border-t border-slate-800 pt-5">
            <div class="mb-3 flex items-center gap-1.5 text-[11px] text-emerald-400">
              <UIcon name="i-lucide-file-check-2" class="h-3.5 w-3.5" />
              <span class="font-semibold uppercase tracking-wide">
                {{ incorporated ? docNoun : t('brainstorm.docDraft', { doc: docNoun }) }}
              </span>
            </div>
            <div v-for="s in outline.sections" :key="s.id" class="mb-2">
              <button
                v-if="s.title"
                class="group flex w-full items-center gap-2 text-start"
                @click="toggle(s.id)"
              >
                <UIcon
                  name="i-lucide-chevron-right"
                  class="h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform"
                  :class="collapsed[s.id] ? '' : 'rotate-90'"
                />
                <span
                  class="font-semibold text-white"
                  :class="s.depth <= 1 ? 'text-base' : s.depth === 2 ? 'text-sm' : 'text-xs'"
                  v-html="s.titleHtml"
                />
              </button>
              <div
                v-show="!s.title || !collapsed[s.id]"
                class="reader-prose mt-1 ps-5.5 text-[13px] leading-relaxed text-slate-300"
                v-html="s.bodyHtml"
              />
            </div>
          </section>
        </template>
      </div>

      <!-- right action rail -->
      <aside class="hidden w-72 shrink-0 flex-col border-s border-slate-800 lg:flex">
        <div class="flex flex-col gap-4 px-4 py-5">
          <div v-if="session" class="space-y-2 text-xs text-slate-400">
            <div class="flex items-center justify-between">
              <span>{{ t('brainstorm.rail.options') }}</span>
              <span class="text-slate-300">{{ session.items.length }}</span>
            </div>
            <div class="flex items-center justify-between">
              <span>{{ t('brainstorm.rail.open') }}</span>
              <span class="text-slate-300">{{ openCount }}</span>
            </div>
            <div class="flex items-center justify-between">
              <span>{{ t('brainstorm.rail.chosen') }}</span>
              <span class="text-slate-300">{{ answeredCount }}</span>
            </div>
            <div v-if="session.model" class="flex items-center justify-between">
              <span>{{ t('brainstorm.rail.model') }}</span>
              <span class="truncate ps-2 text-slate-500">{{ session.model }}</span>
            </div>
          </div>

          <!-- action: ready (choose → incorporate / proceed) -->
          <div
            v-if="session && status === 'ready'"
            class="space-y-2 border-t border-slate-800 pt-4"
          >
            <UButton
              v-if="canProceed"
              color="primary"
              size="sm"
              block
              icon="i-lucide-arrow-right"
              :ui="{ leadingIcon: 'rtl:-scale-x-100', trailingIcon: 'rtl:-scale-x-100' }"
              :loading="acting"
              :disabled="!access.canExecuteRuns.value"
              :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
              @click="proceed"
            >
              {{ t('brainstorm.proceedNothing') }}
            </UButton>
            <UButton
              v-else
              color="primary"
              size="sm"
              block
              icon="i-lucide-wand-sparkles"
              :loading="reworking"
              :disabled="!canIncorporate || !access.canExecuteRuns.value"
              :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
              @click="incorporate()"
            >
              {{ t('brainstorm.incorporateChoices') }}
            </UButton>
            <p class="text-[11px] leading-relaxed text-slate-500">
              <template v-if="canProceed">
                {{ t('brainstorm.hint.allDismissed') }}
              </template>
              <template v-else-if="canIncorporate">
                {{ t('brainstorm.hint.incorporate', { doc: docNoun }) }}
              </template>
              <template v-else> {{ t('brainstorm.hint.chooseAll') }} </template>
            </p>
          </div>

          <!-- action: merged (inspect → re-run / redo) -->
          <div v-if="session && merged" class="space-y-2 border-t border-slate-800 pt-4">
            <UButton
              color="primary"
              size="sm"
              block
              icon="i-lucide-sparkles"
              :loading="busy"
              :disabled="!access.canExecuteRuns.value"
              :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
              @click="reReview"
            >
              {{ busy ? t('brainstorm.reRunning') : t('brainstorm.reRun') }}
            </UButton>
            <UButton
              color="neutral"
              variant="soft"
              size="sm"
              block
              icon="i-lucide-pencil"
              @click="
                () => {
                  showRedo = !showRedo
                }
              "
            >
              {{ t('brainstorm.redoIncorporation') }}
            </UButton>
            <div v-if="showRedo" class="space-y-2">
              <UTextarea
                v-model="redoComment"
                :rows="3"
                autoresize
                size="sm"
                class="w-full"
                :placeholder="t('brainstorm.redoPlaceholder')"
              />
              <UButton
                color="primary"
                variant="soft"
                size="xs"
                block
                icon="i-lucide-wand-sparkles"
                :loading="reworking"
                :disabled="!redoComment.trim() || !access.canExecuteRuns.value"
                :title="access.canExecuteRuns.value ? undefined : t('access.noRunExecute')"
                @click="incorporate(redoComment.trim())"
              >
                {{ t('brainstorm.redoWithDirection') }}
              </UButton>
            </div>
            <p class="text-[11px] leading-relaxed text-slate-500">
              {{ t('brainstorm.mergedHint') }}
            </p>
          </div>

          <div
            v-if="session && incorporated"
            class="border-t border-slate-800 pt-4 text-[11px] leading-relaxed text-slate-500"
          >
            {{ t('brainstorm.incorporatedFooter') }}
          </div>
        </div>
      </aside>
    </div>
  </ResultWindowShell>
</template>

<style scoped>
.pl-5\.5 {
  padding-left: 1.375rem;
}
/* Minimal CommonMark styling for the converged-direction reader (mirrors the prose
   review window's reader-prose). */
.reader-prose :deep(p) {
  margin: 0.4rem 0;
}
.reader-prose :deep(ul),
.reader-prose :deep(ol) {
  margin: 0.4rem 0;
  padding-left: 1.25rem;
  list-style: revert;
}
.reader-prose :deep(li) {
  margin: 0.2rem 0;
}
.reader-prose :deep(strong) {
  color: rgb(226 232 240);
  font-weight: 600;
}
.reader-prose :deep(code) {
  border-radius: 0.25rem;
  background: rgb(2 6 23 / 0.6);
  padding: 0.05rem 0.3rem;
  font-size: 0.85em;
}
.reader-prose :deep(pre) {
  margin: 0.5rem 0;
  overflow-x: auto;
  border-radius: 0.5rem;
  background: rgb(2 6 23 / 0.6);
  padding: 0.75rem;
}
.reader-prose :deep(blockquote) {
  margin: 0.5rem 0;
  border-left: 2px solid rgb(51 65 85);
  padding-left: 0.75rem;
  color: rgb(148 163 184);
}
</style>
