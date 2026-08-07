<script setup lang="ts">
import { isDesignSource } from '@cat-factory/contracts'
import type { DocumentBoardPlan } from '~/types/domain'

// Preview the structure an imported document expands into, then spawn it. The
// plan is fetched fresh on open; a badge makes clear whether an LLM or the
// deterministic heading parser produced it.
//
// A PROSE document spawns new top-level frames: the planner's job there is to decompose a
// specification into services. A DESIGN document cannot answer that question — it describes
// screens, and asked for an architecture it produces a service per Figma page — so it is planned
// INTO a service that already exists, and the frame picker below is required before a plan is
// even requested. The frame is then sent to the spawn as well, so the write re-plans against the
// same target and nothing the preview showed is discarded.
const { t } = useI18n()
const ui = useUiStore()
const board = useBoardStore()
const documents = useDocumentsStore()
const toast = useToast()

/** Design documents are planned into an existing service; prose documents at the board root. */
const needsTarget = computed(() => !!ui.spawnPreview && isDesignSource(ui.spawnPreview.source))
const targetFrameId = ref<string | undefined>()
const frameOptions = computed(() =>
  board.frames.map((frame) => ({ label: frame.title, value: frame.id })),
)

const open = computed({
  get: () => ui.spawnPreview !== null,
  set: (v: boolean) => {
    if (!v) ui.closeSpawnPreview()
  },
})

const plan = ref<DocumentBoardPlan | null>(null)
const loadingPlan = ref(false)
const spawning = ref(false)

// Declared BEFORE the planning watcher so it runs first: a target picked for the previous
// document must not survive into the next one, where it would silently plan a different design
// into a service nobody chose for it.
watch(
  () => ui.spawnPreview?.externalId,
  () => {
    targetFrameId.value = undefined
  },
)

// The preview re-plans whenever the TARGET moves, not only when the document does: a plan
// authored for one service says nothing about another, and leaving the previous frame's modules
// on screen under a newly-picked service is the misreading this whole variant exists to prevent.
watch(
  [() => ui.spawnPreview?.externalId, targetFrameId],
  async ([externalId]) => {
    plan.value = null
    const preview = ui.spawnPreview
    if (!externalId || !preview) return
    if (needsTarget.value && !targetFrameId.value) return
    loadingPlan.value = true
    try {
      plan.value = await documents.plan(preview.source, externalId, targetFrameId.value)
    } catch (e) {
      toast.add({
        title: t('documents.spawn.planFailed'),
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    } finally {
      loadingPlan.value = false
    }
  },
  { immediate: true },
)

async function spawn() {
  const preview = ui.spawnPreview
  if (!preview) return
  spawning.value = true
  try {
    const result = await documents.spawn(preview.source, preview.externalId, targetFrameId.value)
    toast.add({
      title: t('documents.spawn.spawned'),
      description: t('documents.spawn.summary', {
        frames: t('documents.spawn.frameCount', { count: result.frames }, result.frames),
        modules: t('documents.spawn.moduleCount', { count: result.modules }, result.modules),
        tasks: t('documents.spawn.taskCount', { count: result.tasks }, result.tasks),
      }),
      icon: 'i-lucide-check',
      color: 'success',
    })
    ui.closeSpawnPreview()
    ui.closeDocumentImport()
  } catch (e) {
    toast.add({
      title: t('documents.spawn.spawnFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    spawning.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="t('documents.spawn.title')">
    <template #body>
      <div class="space-y-4">
        <div v-if="plan" class="flex items-center justify-between gap-2">
          <UBadge
            :color="plan.planner === 'llm' ? 'primary' : 'neutral'"
            variant="subtle"
            size="sm"
          >
            {{
              plan.planner === 'llm'
                ? t('documents.spawn.plannerLlm')
                : t('documents.spawn.plannerHeadings')
            }}
          </UBadge>
          <span class="text-xs text-slate-400">{{
            plan.targetFrameId ? t('documents.spawn.intoService') : t('documents.spawn.asTopLevel')
          }}</span>
        </div>

        <UFormField
          v-if="needsTarget"
          :label="t('documents.spawn.target.label')"
          :help="t('documents.spawn.target.help')"
        >
          <USelectMenu
            v-model="targetFrameId"
            :items="frameOptions"
            value-key="value"
            :placeholder="t('documents.spawn.target.placeholder')"
            class="w-full"
            data-testid="spawn-target-frame"
          />
        </UFormField>

        <p
          v-if="needsTarget && !targetFrameId"
          class="text-xs text-slate-400"
          data-testid="spawn-target-required"
        >
          {{ t('documents.spawn.target.required') }}
        </p>

        <div v-if="loadingPlan" class="flex items-center gap-2 text-sm text-slate-400">
          <UIcon name="i-lucide-loader" class="h-4 w-4 animate-spin" />
          {{ t('documents.spawn.buildingPlan') }}
        </div>

        <div v-else-if="plan" class="max-h-80 space-y-3 overflow-y-auto pe-1">
          <div
            v-for="(frame, fi) in plan.frames"
            :key="fi"
            class="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
          >
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-box" class="h-4 w-4 text-indigo-400" />
              <span class="text-sm font-semibold text-white">{{ frame.title }}</span>
              <UBadge variant="subtle" size="sm" color="neutral">{{ frame.type }}</UBadge>
            </div>

            <ul v-if="frame.tasks.length" class="mt-2 space-y-1 ps-6">
              <li
                v-for="(task, ti) in frame.tasks"
                :key="`t-${ti}`"
                class="flex items-center gap-1.5 text-xs text-slate-300"
              >
                <UIcon name="i-lucide-square-check-big" class="h-3 w-3 text-slate-500" />
                {{ task.title }}
              </li>
            </ul>

            <div v-for="(mod, mi) in frame.modules" :key="`m-${mi}`" class="mt-2 ps-4">
              <div class="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                <UIcon name="i-lucide-folder" class="h-3.5 w-3.5 text-amber-400" />
                {{ mod.name }}
              </div>
              <ul class="mt-1 space-y-1 ps-5">
                <li
                  v-for="(task, ti) in mod.tasks"
                  :key="`mt-${ti}`"
                  class="flex items-center gap-1.5 text-xs text-slate-300"
                >
                  <UIcon name="i-lucide-square-check-big" class="h-3 w-3 text-slate-500" />
                  {{ task.title }}
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-1">
          <UButton color="neutral" variant="ghost" @click="ui.closeSpawnPreview()">{{
            t('common.cancel')
          }}</UButton>
          <UButton
            color="primary"
            icon="i-lucide-wand-sparkles"
            :loading="spawning"
            :disabled="!plan || loadingPlan"
            @click="spawn"
          >
            {{ t('documents.spawn.spawnOntoBoard') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
