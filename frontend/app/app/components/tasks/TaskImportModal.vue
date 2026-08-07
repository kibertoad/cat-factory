<script setup lang="ts">
// Create a board task from a connected tracker's issue. Use the inline picker to find an issue
// (search by title, pick an already-imported one, or paste a URL/key): choosing one opens the
// prefilled add-task form (title seeded, issue staged as linked context) where the
// user confirms the pipeline / presets before it's created. This is the same picker
// the add-task form uses for "context issues", so the two behave identically. A
// pasted parent/epic reference can instead be spawned as a whole linked task group.
//
// Where the task lands depends on how the modal was opened, and `useContainerTargets` is the shared
// answer (`<BugHuntModal>` is the same question from the same frame header). From a service frame's
// own "create task from issue" button that frame settles the SERVICE, so the modal states it rather
// than asking; a frame with modules still asks frame-or-which-module, scoped to that frame, because
// the button never answered that half. Opened standalone (the command bar / the Integrations hub)
// there is no frame behind it and every container on the board is a candidate.
import type { TaskSourceKind } from '~/types/domain'
import type { PendingContext } from '~/composables/useContextLinking'
import { type AddSourceLabels, addChoicesOf, buildSourceChoices } from '~/utils/sourcePicker'
import ContextIssuePicker from '~/components/tasks/ContextIssuePicker.vue'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const { t } = useI18n()
const ui = useUiStore()
const tasks = useTasksStore()
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

const descriptor = computed(() => (source.value ? tasks.descriptorFor(source.value) : undefined))

/**
 * The trackers the "nothing connected yet" state offers, worded per add action off the shared
 * builder rather than re-deciding `available ? enable : connect` here. `enable` is connected but
 * toggled off for this workspace, so the user is never told to connect what they already have.
 */
const ADD_LABEL: AddSourceLabels<'connect' | 'enable'> = {
  connect: (label) => t('tasks.import.connectSource', { label }),
  enable: (label) => t('tasks.import.enableSource', { label }),
}
const addableSources = computed(() => addChoicesOf(buildSourceChoices(tasks.sources, source.value)))

// Where the new task lands. `pinned` is re-resolved through the board on every read, so a frame
// deleted while the modal sat open widens back to the whole board AND drops the selection that
// pointed at it (`useContainerTargets`).
const {
  pinned: pinnedContainer,
  items: containerItems,
  containerId,
  stated: containerStated,
  reset: resetContainer,
} = useContainerTargets(() => ui.taskImport?.containerId)

// Which surface this is. Derived from the RESOLVED frame rather than the id the modal was opened
// with, so the title cannot claim the frame-scoped surface while the body renders the standalone
// browser: they answer "was this opened from a frame" from one source.
const title = computed(() =>
  pinnedContainer.value ? t('tasks.import.titleCreate') : t('tasks.import.titleBrowse'),
)

watch(open, (isOpen) => {
  if (isOpen) {
    ref_.value = ''
    source.value = ui.taskImport?.source ?? tasks.offeredSources[0]?.source ?? undefined
    resetContainer()
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
            v-for="choice in addableSources"
            :key="choice.source"
            color="primary"
            variant="soft"
            :icon="choice.icon"
            @click="ui.openTaskConnect(choice.source)"
          >
            {{ ADD_LABEL[choice.action](choice.label) }}
          </UButton>
        </div>
      </div>

      <!-- No service frame yet → nowhere to create a task. -->
      <p v-else-if="!containerItems.length" class="text-center text-xs text-slate-500">
        {{ t('tasks.import.needFrameFirst') }}
      </p>

      <!-- Main form -->
      <div v-else class="space-y-4">
        <!-- Where the new task lands. Stated when there is one legal target (opened from a service
             frame that has no modules); otherwise a real choice, scoped to that frame when the
             modal was opened from one. -->
        <p v-if="containerStated" class="text-xs text-slate-400">
          <i18n-t keypath="tasks.import.creatingIn" tag="span" scope="global">
            <template #container>
              <span class="font-medium text-slate-200">{{ pinnedContainer!.title }}</span>
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
             or paste a URL/key, and choosing one opens the prefilled add-task form. The
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
