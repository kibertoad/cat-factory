<script setup lang="ts">
// Create a board task from a connected tracker's issue. Use the inline picker to find an issue
// (search by title, pick an already-imported one, or paste a URL/key) — choosing one opens the
// prefilled add-task form (title seeded, issue staged as linked context) where the
// user confirms the pipeline / presets before it's created. This is the same picker
// the add-task form uses for "context issues", so the two behave identically. A
// pasted parent/epic reference can instead be spawned as a whole linked task group.
//
// Where the task lands depends on how the modal was opened. From a service frame's own
// "create task from issue" button the target IS that frame — the button exists nowhere else, so
// the modal states the frame rather than asking a question whose answer it already has. Opened
// standalone (the command bar / the Integrations hub) it is the general tracker browser, with no
// frame behind it, so there the container is a genuine choice and the picker stays.
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
// `v-model:source`, whose selector always shows (and can add) the tracker in use.
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

// The frame the modal was opened from, when it was one: the create-in target is then fixed and
// the picker below is replaced by a line naming it. Resolved THROUGH the board rather than
// trusted as an id, so a frame deleted while the modal sat open falls back to the picker instead
// of pinning the target to something nothing can be created in.
const pinnedContainer = computed(() => {
  const id = ui.taskImport?.containerId
  return id ? board.getBlock(id) : undefined
})

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
    // Opened from a service frame → that frame IS the target; otherwise fall back to the first
    // container on the board as the picker's initial selection.
    containerId.value = pinnedContainer.value?.id ?? containerItems.value[0]?.value
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
        <!-- Where the new task lands. Opened from a service frame the target is that frame and
             is stated, not asked; opened standalone it is a real choice. -->
        <p v-if="pinnedContainer" class="text-xs text-slate-400">
          <i18n-t keypath="tasks.import.creatingIn" tag="span" scope="global">
            <template #container>
              <span class="font-medium text-slate-200">{{ pinnedContainer.title }}</span>
            </template>
          </i18n-t>
        </p>
        <UFormField v-else :label="t('tasks.import.createTasksIn')">
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
             search is scoped to the chosen container's repo (so a GitHub search stays
             in that service's repo and a pasted URL / bare number resolves there). -->
        <UFormField v-if="containerId" :label="t('tasks.import.searchIssues')">
          <ContextIssuePicker
            v-model:source="source"
            :scope-block-id="containerId"
            @pick="createFromPick"
          />
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
