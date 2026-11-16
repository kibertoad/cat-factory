<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useReactiveSlots } from '@modular-vue/runtime'
import type { Project } from '@cat-factory/contracts'
import EmptyState from '~/components/common/EmptyState.vue'
import TakeoverShell from '~/components/common/TakeoverShell.vue'
import ProjectCredentialReadiness from '~/components/projects/view/ProjectCredentialReadiness.vue'
import ProjectOutcomeFallback from '~/components/projects/view/ProjectOutcomeFallback.vue'
import ProjectOutcomeHistory from '~/components/projects/view/ProjectOutcomeHistory.vue'
import ProjectStoragePolicy from '~/components/projects/view/ProjectStoragePolicy.vue'
import type { AppSlots, ProjectViewContribution } from '~/modular/slots'
import { showOverrideField } from '~/utils/uiMode'

// One project opened from its root on the board, whatever its kind: what it pins, the reader its
// kind contributes (or the generic one), every outcome with where its body lives, whether its
// definition's credentials resolve for this board, and (advanced) the outcome-storage tiers.
// Re-read when a task under the project settles, so a finished run shows without a refresh.

const props = defineProps<{ project: Project; title: string }>()
const open = defineModel<boolean>('open', { required: true })
const { t } = useI18n()
const projectViews = useProjectViewsStore()
const execution = useExecutionStore()
const board = useBoardStore()
const uiMode = useUiModeStore()
const errors = usePipelineErrorToast()
const access = useWorkspaceAccess()
const slots = useReactiveSlots<AppSlots>()

const view = computed(() => projectViews.views[props.project.id])
const policy = computed(() => projectViews.policies[props.project.id])
// The kind's reader. The client plugin already refused two readers for one kind at boot.
const reader = computed(() =>
  (slots.value.projectViews ?? []).find(
    (entry: ProjectViewContribution) => entry.id === props.project.kind,
  ),
)
const tab = ref('view')

async function load() {
  try {
    await projectViews.load(props.project.id)
  } catch (e) {
    errors.present(e, 'projects.view.loadFailed')
  }
}

async function loadPolicy() {
  try {
    await projectViews.loadPolicy(props.project.id)
  } catch (e) {
    errors.present(e, 'projects.view.storage.loadFailed')
  }
}

// The storage tiers are board configuration, read and set only by who may manage settings.
onModalOpen(open, () => {
  tab.value = 'view'
  void load()
  if (access.canManageSettings.value) void loadPolicy()
})

// Each run under the project, by status. A change means a task settled, parked or started, and
// only the first two can move the outcomes, so re-read then.
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
  {
    label: reader.value ? t(reader.value.labelKey) : t('projects.view.tabs.latest'),
    value: 'view',
  },
  { label: t('projects.view.tabs.outcomes'), value: 'outcomes' },
  ...(view.value?.definition
    ? [
        {
          label: t('projects.view.tabs.credentials'),
          value: 'credentials',
          ...(missingCredentials.value ? { badge: missingCredentials.value } : {}),
        },
      ]
    : []),
  ...(showStorage.value ? [{ label: t('projects.view.tabs.storage'), value: 'storage' }] : []),
])
</script>

<template>
  <Teleport to="body">
    <TakeoverShell
      v-if="open"
      :label="t('projects.view.title', { title })"
      class="flex-col bg-app-950/96 backdrop-blur-sm"
      data-testid="project-view"
      @close="open = false"
    >
      <header class="flex flex-wrap items-center gap-3 border-b border-default px-6 py-4">
        <UIcon :name="reader?.icon ?? 'i-lucide-folder-kanban'" class="size-5 text-app-hue-teal" />
        <div class="min-w-0">
          <h1 class="truncate text-base font-semibold text-highlighted">
            {{ t('projects.view.title', { title }) }}
          </h1>
          <p v-if="view?.pin" class="truncate text-xs text-dimmed" data-testid="project-view-pin">
            {{
              t('projects.view.pin', {
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
            :loading="projectViews.loading[project.id]"
            @click="load"
          >
            {{ t('projects.view.refresh') }}
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
          icon="i-lucide-folder-kanban"
          :title="
            projectViews.loading[project.id]
              ? t('projects.view.loading')
              : t('projects.view.unavailable')
          "
          compact
        />
        <template v-else>
          <UAlert
            v-if="view.definitionChanged"
            class="mb-3"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="t('projects.view.definitionChanged')"
          />
          <UAlert
            v-else-if="view.pin && !view.definition"
            class="mb-3"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="t('projects.view.definitionMissing')"
          />
          <UAlert
            v-if="view.outcomes.some((o) => !o.storage.readable)"
            class="mb-3"
            color="error"
            variant="subtle"
            icon="i-lucide-cloud-off"
            :title="t('projects.view.unreadableOutcomes')"
          />
          <UTabs v-model="tab" :items="tabs" :content="false" class="mb-4" />

          <template v-if="tab === 'view'">
            <component :is="reader.component" v-if="reader" :project="project" :board="view" />
            <ProjectOutcomeFallback v-else :project="project" :board="view" />
          </template>
          <ProjectOutcomeHistory
            v-else-if="tab === 'outcomes'"
            :project="project"
            :outcomes="view.outcomes"
          />
          <ProjectCredentialReadiness
            v-else-if="tab === 'credentials'"
            :credentials="view.credentials"
          />
          <ProjectStoragePolicy
            v-else-if="tab === 'storage' && policy"
            :key="project.id"
            :project-id="project.id"
            :view="policy"
          />
        </template>
      </div>
    </TakeoverShell>
  </Teleport>
</template>
