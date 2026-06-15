<script setup lang="ts">
import type { DocumentBoardPlan } from '~/types/domain'

// Preview the structure an imported document expands into, then spawn it. The
// plan is fetched fresh on open; a badge makes clear whether an LLM or the
// deterministic heading parser produced it.
const ui = useUiStore()
const documents = useDocumentsStore()
const board = useBoardStore()
const toast = useToast()

const open = computed({
  get: () => ui.spawnPreview !== null,
  set: (v: boolean) => {
    if (!v) ui.closeSpawnPreview()
  },
})

const targetFrameId = computed(() => ui.spawnPreview?.targetFrameId ?? null)
const targetFrameTitle = computed(() =>
  targetFrameId.value ? board.getBlock(targetFrameId.value)?.title : null,
)

const plan = ref<DocumentBoardPlan | null>(null)
const loadingPlan = ref(false)
const spawning = ref(false)

watch(
  () => ui.spawnPreview?.externalId,
  async (externalId) => {
    plan.value = null
    const preview = ui.spawnPreview
    if (!externalId || !preview) return
    loadingPlan.value = true
    try {
      plan.value = await documents.plan(preview.source, externalId)
    } catch (e) {
      toast.add({
        title: 'Could not build a plan',
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
    const result = await documents.spawn(
      preview.source,
      preview.externalId,
      targetFrameId.value ?? undefined,
    )
    toast.add({
      title: 'Structure spawned',
      description: `${result.frames} frames · ${result.modules} modules · ${result.tasks} tasks`,
      icon: 'i-lucide-check',
      color: 'success',
    })
    ui.closeSpawnPreview()
    ui.closeDocumentImport()
  } catch (e) {
    toast.add({
      title: 'Spawn failed',
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
  <UModal v-model:open="open" title="Preview structure">
    <template #body>
      <div class="space-y-4">
        <div v-if="plan" class="flex items-center justify-between gap-2">
          <UBadge
            :color="plan.planner === 'llm' ? 'primary' : 'neutral'"
            variant="subtle"
            size="sm"
          >
            {{ plan.planner === 'llm' ? 'AI-generated' : 'From headings' }}
          </UBadge>
          <span v-if="targetFrameTitle" class="text-xs text-slate-400">
            into <span class="font-medium text-slate-200">{{ targetFrameTitle }}</span>
          </span>
          <span v-else class="text-xs text-slate-400">as new top-level frames</span>
        </div>

        <div v-if="loadingPlan" class="flex items-center gap-2 text-sm text-slate-400">
          <UIcon name="i-lucide-loader" class="h-4 w-4 animate-spin" /> Building plan…
        </div>

        <div v-else-if="plan" class="max-h-80 space-y-3 overflow-y-auto pr-1">
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

            <ul v-if="frame.tasks.length" class="mt-2 space-y-1 pl-6">
              <li
                v-for="(task, ti) in frame.tasks"
                :key="`t-${ti}`"
                class="flex items-center gap-1.5 text-xs text-slate-300"
              >
                <UIcon name="i-lucide-square-check-big" class="h-3 w-3 text-slate-500" />
                {{ task.title }}
              </li>
            </ul>

            <div v-for="(mod, mi) in frame.modules" :key="`m-${mi}`" class="mt-2 pl-4">
              <div class="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                <UIcon name="i-lucide-folder" class="h-3.5 w-3.5 text-amber-400" />
                {{ mod.name }}
              </div>
              <ul class="mt-1 space-y-1 pl-5">
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
          <UButton color="neutral" variant="ghost" @click="ui.closeSpawnPreview()">Cancel</UButton>
          <UButton
            color="primary"
            icon="i-lucide-wand-sparkles"
            :loading="spawning"
            :disabled="!plan || loadingPlan"
            @click="spawn"
          >
            Spawn onto board
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
