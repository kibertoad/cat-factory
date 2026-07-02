<script setup lang="ts">
// Create a board task from a connected tracker's issue. Pick a container (service
// frame or module), then use the inline picker below to find an issue (search by
// title, pick an already-imported one, or paste a URL/key) — choosing one opens the
// prefilled add-task form (title seeded, issue staged as linked context) where the
// user confirms the pipeline / presets before it's created. This is the same picker
// the add-task form uses for "context issues", so the two behave identically. A
// pasted parent/epic reference can instead be spawned as a whole linked task group.
import type { TaskSourceKind } from '~/types/domain'
import type { PendingContext } from '~/composables/useContextLinking'
import ContextIssuePicker from '~/components/tasks/ContextIssuePicker.vue'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const { t } = useI18n()
const ui = useUiStore()
const tasks = useTasksStore()
const board = useBoardStore()
const toast = useToast()

const open = computed({
  get: () => ui.taskImport !== null,
  set: (v: boolean) => {
    if (!v) ui.closeTaskImport()
  },
})
const back = useIntegrationBack(open)

// The tracker being browsed. Owned here (not the picker) so the epic action and the
// ref-input placeholder share the same selected source; passed to the picker via
// `v-model:source` with `always-show-source` so it's always visible + selectable.
const source = ref<TaskSourceKind | undefined>(undefined)
const ref_ = ref('')
const importing = ref(false)

// When opened from a service frame the modal is the "create a task from an issue"
// surface; opened standalone it's the general tracker-issue browser/importer.
const title = computed(() =>
  ui.taskImport?.containerId ? t('tasks.import.titleCreate') : t('tasks.import.titleBrowse'),
)

const descriptor = computed(() => (source.value ? tasks.descriptorFor(source.value) : undefined))

// The container (service frame or module) a new task is created in.
const containerId = ref<string | undefined>(undefined)

// Containers a new task can be created in: every service frame and module on the
// board. Modules are labelled with their parent frame so the choice is unambiguous.
const containerItems = computed(() =>
  board.blocks
    .filter((b) => b.level === 'frame' || b.level === 'module')
    .map((b) => ({
      label:
        b.level === 'module'
          ? `${board.getBlock(b.parentId ?? '')?.title ?? '?'} › ${b.title}`
          : b.title,
      value: b.id,
    })),
)
watch(open, (isOpen) => {
  if (isOpen) {
    ref_.value = ''
    source.value = ui.taskImport?.source ?? tasks.offeredSources[0]?.source ?? undefined
    // Opened from a service frame → preselect it as the create-in target; otherwise
    // fall back to the first container on the board.
    containerId.value = ui.taskImport?.containerId ?? containerItems.value[0]?.value
    tasks.loadTasks().catch(() => {})
  }
})

// Choosing an issue in the picker hands off to the add-task form, prefilled with the
// issue title and the issue staged as linked context (so agents see its description +
// comments). The user still confirms pipeline / preset there before the task is
// created. A search hit / pasted ref carries `needsImport`, so the add-task form
// resolves its body (by importing) and folds it into the new task's description; an
// already-imported issue carries its body directly.
function createFromPick(item: PendingContext) {
  if (!containerId.value) return
  // The picker titles rows as "EXTERNALID · Title"; seed the task with the clean
  // title. A pasted ref has no title (title === the raw ref), so leave it blank for
  // the user to name in the form.
  const seededTitle = item.title === item.externalId ? '' : item.title.replace(/^[^·]+·\s*/, '')
  ui.closeTaskImport()
  ui.openAddTask(containerId.value, { title: seededTitle, context: [item] })
}

// Spawn the referenced issue as an EPIC: an epic node + a task per child issue (into the
// chosen container), with dependency edges seeded from the issues' blocked-by/depends-on
// links. Needs a container for the child tasks.
async function doSpawnEpic() {
  const value = ref_.value.trim()
  if (!value || !source.value || !containerId.value) return
  importing.value = true
  try {
    const { epic, tasks: spawned } = await tasks.spawnEpic(source.value, value, containerId.value)
    ref_.value = ''
    ui.closeTaskImport()
    ui.select(epic.id)
    toast.add({
      title: t('tasks.import.epicSpawned', { title: epic.title }),
      description: t('tasks.import.epicChildren', { count: spawned.length }, spawned.length),
      icon: 'i-lucide-layers',
    })
  } catch (e) {
    toast.add({
      title: t('tasks.import.epicFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="title">
    <template #title>
      <IntegrationBackTitle :title="title" @back="back" />
    </template>
    <template #body>
      <!-- Empty state: no source offered (none connected/installed, or all disabled) -->
      <div v-if="!tasks.anyOffered" class="space-y-3 text-center">
        <UIcon name="i-lucide-plug" class="mx-auto h-8 w-8 text-slate-500" />
        <p class="text-sm text-slate-400">{{ t('tasks.import.connectFirst') }}</p>
        <div class="flex justify-center gap-2">
          <UButton
            v-for="s in tasks.sources"
            :key="s.source"
            color="primary"
            variant="soft"
            :icon="s.icon"
            @click="ui.openTaskConnect(s.source)"
          >
            {{
              s.available
                ? t('tasks.import.enableSource', { label: s.label })
                : t('tasks.import.connectSource', { label: s.label })
            }}
          </UButton>
        </div>
      </div>

      <!-- No service frame yet → nowhere to create a task. -->
      <p v-else-if="!containerItems.length" class="text-center text-xs text-slate-500">
        {{ t('tasks.import.needFrameFirst') }}
      </p>

      <!-- Main form -->
      <div v-else class="space-y-4">
        <!-- Where the new task lands (preselected when opened from a service frame). -->
        <UFormField :label="t('tasks.import.createTasksIn')">
          <USelect
            v-model="containerId"
            :items="containerItems"
            :placeholder="t('tasks.import.pickContainer')"
            class="w-full"
          />
        </UFormField>

        <!-- Find an issue and create a task from it. Same picker the add-task form
             uses for context issues: search by title, pick an already-imported one,
             or paste a URL/key — choosing one opens the prefilled add-task form. The
             source selector is always shown here so it's clear which tracker is in
             use. -->
        <UFormField :label="t('tasks.import.searchIssues')">
          <ContextIssuePicker v-model:source="source" always-show-source @pick="createFromPick" />
        </UFormField>

        <!-- Secondary: spawn a parent/epic issue as a whole linked task group. -->
        <div class="space-y-2 border-t border-slate-800 pt-3">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ t('tasks.import.asEpic') }}
          </span>
          <div class="flex items-end gap-2">
            <UFormField :label="descriptor?.refLabel ?? t('tasks.import.refLabel')" class="flex-1">
              <UInput
                v-model="ref_"
                :placeholder="descriptor?.refPlaceholder"
                class="w-full"
                @keydown.enter="doSpawnEpic"
              />
            </UFormField>
            <UButton
              color="primary"
              variant="soft"
              icon="i-lucide-layers"
              :loading="importing"
              :disabled="!ref_.trim() || !containerId"
              :title="
                containerId
                  ? t('tasks.import.asEpicTitleReady')
                  : t('tasks.import.asEpicTitleNeedsContainer')
              "
              @click="doSpawnEpic"
            >
              {{ t('tasks.import.asEpic') }}
            </UButton>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
