<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Project } from '@cat-factory/contracts'
import EmptyState from '~/components/common/EmptyState.vue'
import MarkdownProse from '~/components/common/MarkdownProse.vue'
import SectionLabel from '~/components/common/SectionLabel.vue'
import TakeoverShell from '~/components/common/TakeoverShell.vue'
import ResearchCredentialReadiness from '~/components/research/ResearchCredentialReadiness.vue'
import ResearchFindingItem from '~/components/research/ResearchFindingItem.vue'
import ResearchFollowUpModal from '~/components/research/ResearchFollowUpModal.vue'
import ResearchRevisionHistory from '~/components/research/ResearchRevisionHistory.vue'
import ResearchStoragePolicy from '~/components/research/ResearchStoragePolicy.vue'
import { readerTopics } from '~/utils/research'
import { showOverrideField } from '~/utils/uiMode'

// A research project's findings reader: what it pins, coverage per topic, every question with its
// current answer and evidence, run-level learnings, the revision history, whether its credentials
// resolve for this board, and (advanced) the findings-storage tiers. Re-read when a research task
// under the project settles, so a finished follow-up shows without a manual refresh.

const props = defineProps<{ project: Project; title: string }>()
const open = defineModel<boolean>('open', { required: true })
const { t } = useI18n()
const research = useResearchStore()
const execution = useExecutionStore()
const board = useBoardStore()
const uiMode = useUiModeStore()
const errors = usePipelineErrorToast()
const access = useWorkspaceAccess()

const view = computed(() => research.views[props.project.id])
const policy = computed(() => research.policies[props.project.id])
const followUpOpen = ref(false)
const tab = ref('findings')

async function load() {
  try {
    await research.load(props.project.id)
  } catch (e) {
    errors.present(e, 'research.loadFailed')
  }
}

async function loadPolicy() {
  try {
    await research.loadPolicy(props.project.id)
  } catch (e) {
    errors.present(e, 'research.storage.loadFailed')
  }
}

// The storage tiers are board configuration, read and set only by who may manage settings.
onModalOpen(open, () => {
  tab.value = 'findings'
  void load()
  if (access.canManageSettings.value) void loadPolicy()
})

// Each research run under the project, by status. A change means a task settled, parked or
// started, and only the first two can move the findings, so re-read then.
const runSignature = computed(() =>
  execution.instances
    .filter((run) => board.getBlock(run.blockId)?.parentId === props.project.rootBlockId)
    .map((run) => `${run.id}:${run.status}`)
    .sort()
    .join('|'),
)
watch(runSignature, (next, previous) => {
  if (open.value && next !== previous) void load()
})

const grouped = computed(() => (view.value ? readerTopics(view.value) : null))
const countsByTopic = computed(
  () => new Map((view.value?.coverage.byTopic ?? []).map((entry) => [entry.topicId, entry.counts])),
)
const total = computed(() => view.value?.coverage.total)
const missingCredentials = computed(
  () => view.value?.credentials.filter((c) => c.status !== 'stored').length ?? 0,
)
// The storage tiers are overrides: shown in advanced mode, and in basic mode only when one is set.
const showStorage = computed(
  () =>
    access.canManageSettings.value &&
    showOverrideField(uiMode.isAdvanced, policy.value?.workspace, policy.value?.project),
)

const tabs = computed(() => [
  { label: t('research.tabs.findings'), value: 'findings' },
  { label: t('research.tabs.revisions'), value: 'revisions' },
  {
    label: t('research.tabs.credentials'),
    value: 'credentials',
    ...(missingCredentials.value ? { badge: missingCredentials.value } : {}),
  },
  ...(showStorage.value ? [{ label: t('research.tabs.storage'), value: 'storage' }] : []),
])
</script>

<template>
  <Teleport to="body">
    <TakeoverShell
      v-if="open"
      :label="t('research.title', { title })"
      class="flex-col bg-app-950/96 backdrop-blur-sm"
      data-testid="research-findings"
      @close="open = false"
    >
      <header class="flex flex-wrap items-center gap-3 border-b border-default px-6 py-4">
        <UIcon name="i-lucide-telescope" class="size-5 text-app-hue-teal" />
        <div class="min-w-0">
          <h1 class="truncate text-base font-semibold text-highlighted">
            {{ t('research.title', { title }) }}
          </h1>
          <p v-if="view" class="truncate text-xs text-dimmed" data-testid="research-pin">
            {{
              t('research.pin', {
                title: view.definition?.title ?? view.pin.definitionKey,
                version: view.pin.definitionVersion,
              })
            }}
          </p>
        </div>
        <div class="ms-auto flex items-center gap-2">
          <UButton
            icon="i-lucide-refresh-cw"
            size="xs"
            color="neutral"
            variant="ghost"
            :loading="research.loading[project.id]"
            @click="load"
          >
            {{ t('research.refresh') }}
          </UButton>
          <UButton
            v-if="view"
            icon="i-lucide-plus"
            size="xs"
            data-testid="research-start-follow-up"
            @click="followUpOpen = true"
          >
            {{ t('research.followUp.open') }}
          </UButton>
          <UButton
            icon="i-lucide-x"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="open = false"
          >
            {{ t('common.close') }}
          </UButton>
        </div>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <EmptyState
          v-if="!view"
          icon="i-lucide-telescope"
          :title="research.loading[project.id] ? t('research.loading') : t('research.unavailable')"
          compact
        />
        <template v-else>
          <UAlert
            v-if="view.definitionChanged"
            class="mb-3"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="t('research.definitionChanged')"
          />
          <UAlert
            v-else-if="!view.definition"
            class="mb-3"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="t('research.definitionMissing')"
          />
          <UAlert
            v-if="view.revisions.some((r) => !r.storage.readable)"
            class="mb-3"
            color="error"
            variant="subtle"
            icon="i-lucide-cloud-off"
            :title="t('research.unreadableRevisions')"
          />
          <p v-if="total" class="mb-3 flex flex-wrap gap-2 text-xs" data-testid="research-coverage">
            <UBadge
              v-for="status in ['answered', 'partial', 'blocked', 'unanswered'] as const"
              :key="status"
              color="neutral"
              variant="subtle"
              size="sm"
            >
              {{ t(`research.coverage.${status}`, { count: total[status] }) }}
            </UBadge>
          </p>
          <UTabs v-model="tab" :items="tabs" :content="false" class="mb-4" />

          <div v-if="tab === 'findings' && grouped" class="space-y-5">
            <MarkdownProse v-if="view.summary" class="text-sm" :text="view.summary" />
            <section v-for="topic in grouped.topics" :key="topic.id" data-testid="research-topic">
              <SectionLabel class="mb-2">
                {{ topic.title }}
                <span class="ms-1 normal-case text-dimmed">
                  {{
                    t('research.topicCoverage', {
                      answered: countsByTopic.get(topic.id)?.answered ?? 0,
                      total: topic.questions.length,
                    })
                  }}
                </span>
              </SectionLabel>
              <div class="space-y-2">
                <ResearchFindingItem v-for="q in topic.questions" :key="q.id" :entry="q" />
              </div>
            </section>
            <section v-if="grouped.adhoc.length">
              <SectionLabel class="mb-2">{{ t('research.adhoc') }}</SectionLabel>
              <div class="space-y-2">
                <ResearchFindingItem v-for="q in grouped.adhoc" :key="q.id" :entry="q" />
              </div>
            </section>
            <section v-if="grouped.retired.length">
              <SectionLabel class="mb-2">{{ t('research.retired') }}</SectionLabel>
              <div class="space-y-2">
                <ResearchFindingItem v-for="q in grouped.retired" :key="q.id" :entry="q" />
              </div>
            </section>
            <section v-if="view.learnings.length">
              <SectionLabel class="mb-2">{{ t('research.learnings') }}</SectionLabel>
              <ul class="space-y-2">
                <li
                  v-for="(learning, i) in view.learnings"
                  :key="i"
                  class="rounded-lg border border-default p-3"
                >
                  <p class="text-sm font-medium">{{ learning.title }}</p>
                  <MarkdownProse
                    v-if="learning.detail"
                    class="mt-1 text-sm"
                    :text="learning.detail"
                  />
                </li>
              </ul>
            </section>
          </div>
          <ResearchRevisionHistory
            v-else-if="tab === 'revisions'"
            :project="project"
            :revisions="view.revisions"
          />
          <ResearchCredentialReadiness
            v-else-if="tab === 'credentials'"
            :credentials="view.credentials"
          />
          <ResearchStoragePolicy
            v-else-if="tab === 'storage' && policy"
            :key="project.id"
            :project-id="project.id"
            :view="policy"
          />
        </template>
      </div>
      <ResearchFollowUpModal
        v-if="view"
        v-model:open="followUpOpen"
        :project="project"
        :view="view"
      />
    </TakeoverShell>
  </Teleport>
</template>
