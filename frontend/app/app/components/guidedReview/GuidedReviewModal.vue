<script setup lang="ts">
// Guided PR review: the overview of a pull request beside tabbed exploration threads. Opened on a
// session, on a pull request (opening or reusing the caller's session for it), or on neither, in
// which case it starts with a picker. Live updates arrive through the `guidedReview` event, which
// the store follows; this window only loads what it shows.
import type { OpenGuidedReviewInput } from '~/types/domain'
import GuidedReviewOverview from '~/components/guidedReview/GuidedReviewOverview.vue'
import GuidedReviewThread from '~/components/guidedReview/GuidedReviewThread.vue'
import GuidedReviewPicker from '~/components/guidedReview/GuidedReviewPicker.vue'
import {
  NEW_THREAD_TAB,
  isStale,
  suggestedQuestionThread,
  threadTabs,
} from '~/components/guidedReview/GuidedReview.logic'

const { t } = useI18n()
const ui = useUiStore()
const store = useGuidedReviewStore()
const github = useGitHubStore()
const { present } = usePipelineErrorToast()

const open = computed({
  get: () => ui.guidedReview !== null,
  set: (value: boolean) => {
    if (!value) ui.closeGuidedReview()
  },
})

const sessionId = ref<string | null>(null)
const opening = ref(false)
const refreshing = ref(false)
const activeTab = ref<string>(NEW_THREAD_TAB)
const draftOpen = ref(true)

const view = computed(() => (sessionId.value ? store.sessions[sessionId.value] : undefined))
const session = computed(() => view.value?.session)
const tabs = computed(() => threadTabs(view.value, draftOpen.value))

const latestHeadSha = computed(() => {
  const s = session.value
  if (!s) return null
  const repo = github.repos.find((r) => String(r.githubId) === s.repoId)
  const pull = repo ? github.pullsForRepo(repo.githubId).find((p) => p.number === s.prNumber) : null
  return pull?.headSha ?? null
})
const stale = computed(
  () => !!session.value && isStale(session.value.reviewedHeadSha, latestHeadSha.value),
)

onModalOpen(open, () => {
  const target = ui.guidedReview
  sessionId.value = null
  draftOpen.value = true
  activeTab.value = NEW_THREAD_TAB
  void github.ensureLoaded()
  if (target?.sessionId) void show(target.sessionId)
  else if (target?.target) void openFor(target.target)
})

async function show(id: string): Promise<void> {
  sessionId.value = id
  try {
    await store.loadSession(id)
    const first = store.sessions[id]?.threads[0]
    if (first) {
      draftOpen.value = false
      activeTab.value = first.id
    }
  } catch (error) {
    present(error, 'guidedReview.errors.load')
  }
}

async function openFor(target: OpenGuidedReviewInput): Promise<void> {
  opening.value = true
  try {
    const opened = await store.open(target)
    await show(opened.session.id)
  } catch (error) {
    present(error, 'guidedReview.errors.open')
  } finally {
    opening.value = false
  }
}

watch(activeTab, (tab) => {
  if (sessionId.value && tab !== NEW_THREAD_TAB && !store.threads[tab]) {
    void store
      .loadThread(sessionId.value, tab)
      .catch((error) => present(error, 'guidedReview.errors.load'))
  }
})

function threadTitle(id: string): string {
  if (id === NEW_THREAD_TAB) return t('guidedReview.thread.new')
  return view.value?.threads.find((th) => th.id === id)?.title || t('guidedReview.thread.untitled')
}

function threadBusy(id: string): boolean {
  return !!view.value?.threads.find((th) => th.id === id)?.pendingMessageId
}

function newThread(): void {
  draftOpen.value = true
  activeTab.value = NEW_THREAD_TAB
}

function onCreated(threadId: string): void {
  draftOpen.value = false
  activeTab.value = threadId
}

async function askSuggested(question: string): Promise<void> {
  if (!sessionId.value) return
  try {
    const created = await store.openThread(sessionId.value, suggestedQuestionThread(question))
    onCreated(created.thread.id)
  } catch (error) {
    present(error, 'guidedReview.errors.ask')
  }
}

async function refresh(): Promise<void> {
  if (!sessionId.value) return
  refreshing.value = true
  try {
    await store.refresh(sessionId.value)
  } catch (error) {
    present(error, 'guidedReview.errors.refresh')
  } finally {
    refreshing.value = false
  }
}

const title = computed(() =>
  session.value
    ? t('guidedReview.titleFor', {
        repo: `${session.value.owner}/${session.value.repo}`,
        number: session.value.prNumber,
        title: session.value.prTitle,
      })
    : t('guidedReview.title'),
)
</script>

<template>
  <UModal v-model:open="open" fullscreen :title="title" data-testid="guided-review-modal">
    <template #body>
      <GuidedReviewPicker v-if="!sessionId" :opening="opening" @open="openFor" />

      <p v-else-if="!session" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="h-4 w-4 animate-spin" />
        {{ t('guidedReview.loading') }}
      </p>

      <div v-else class="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
        <div class="min-h-0 overflow-y-auto lg:w-2/5 lg:pr-2">
          <GuidedReviewOverview
            :session="session"
            :stale="stale"
            :refreshing="refreshing"
            @ask="askSuggested"
            @refresh="refresh"
          />
        </div>

        <div class="flex min-h-[24rem] flex-1 flex-col gap-3 lg:min-h-0">
          <div class="flex flex-wrap items-center gap-1" role="tablist">
            <UButton
              v-for="tab in tabs"
              :key="tab"
              role="tab"
              size="sm"
              :aria-selected="tab === activeTab"
              :variant="tab === activeTab ? 'soft' : 'ghost'"
              :color="tab === activeTab ? 'primary' : 'neutral'"
              :icon="threadBusy(tab) ? 'i-lucide-loader-circle' : undefined"
              :ui="{ leadingIcon: threadBusy(tab) ? 'animate-spin' : '' }"
              :data-testid="`guided-review-tab-${tab}`"
              @click="activeTab = tab"
            >
              <span class="max-w-48 truncate">{{ threadTitle(tab) }}</span>
            </UButton>
            <UButton
              v-if="!draftOpen"
              size="sm"
              variant="ghost"
              icon="i-lucide-plus"
              :aria-label="t('guidedReview.thread.new')"
              data-testid="guided-review-new-thread"
              @click="newThread"
            />
          </div>

          <GuidedReviewThread
            :key="activeTab"
            class="min-h-0 flex-1"
            :session-id="session.id"
            :view="activeTab === NEW_THREAD_TAB ? undefined : store.threads[activeTab]"
            :drafts="view?.drafts.filter((d) => d.threadId === activeTab) ?? []"
            @created="onCreated"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
