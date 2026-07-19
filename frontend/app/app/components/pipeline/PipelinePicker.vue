<script setup lang="ts">
// The rich pipeline picker used wherever a pipeline is chosen (add-task modal, inspector run
// settings). A master–detail popover: the left column lists the selectable pipelines (plus a
// "none / choose at run time" row), and hovering a row reveals that pipeline's full preview — its
// description + the ordered agent steps — in the right column, so a user sees exactly what a
// pipeline does before picking it. The trigger is customizable via the `#trigger` slot (the
// inspector uses a bare icon button; the modal a full-width labelled one).
import { computed, ref } from 'vue'
import type { Pipeline } from '~/types/domain'

const props = withDefaults(
  defineProps<{
    /** Selected pipeline id, or '' for the "none" option. */
    modelValue: string
    /** The pipelines offered (already filtered for the surface, e.g. manual-start allowed). */
    options: Pipeline[]
    /** Label for the "none" row (e.g. "Choose at run time" / "No default"). */
    noneLabel: string
    /** Extra classes for the default trigger button (e.g. full-width in the modal). */
    triggerClass?: string
  }>(),
  { triggerClass: '' },
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()
const { t } = useI18n()

const open = ref(false)
// The row currently hovered, driving the right-column preview. `undefined` ⇒ fall back to the
// selected pipeline; the sentinel '' means the "none" row is hovered (show the none hint).
const hoverId = ref<string | undefined>(undefined)

const selected = computed(() => props.options.find((p) => p.id === props.modelValue))
const triggerLabel = computed(() => selected.value?.name ?? props.noneLabel)

/** The pipeline the right pane previews: the hovered row, else the current selection. */
const previewPipeline = computed<Pipeline | null>(() => {
  const id = hoverId.value ?? props.modelValue
  return id ? (props.options.find((p) => p.id === id) ?? null) : null
})

function choose(id: string) {
  emit('update:modelValue', id)
  open.value = false
}
</script>

<template>
  <UPopover v-model:open="open" :content="{ align: 'start' }">
    <slot name="trigger" :label="triggerLabel">
      <UButton
        color="neutral"
        variant="subtle"
        size="sm"
        icon="i-lucide-workflow"
        trailing-icon="i-lucide-chevron-down"
        :class="triggerClass"
        data-testid="pipeline-picker-trigger"
      >
        {{ triggerLabel }}
      </UButton>
    </slot>

    <template #content>
      <div
        class="flex max-h-[24rem] w-[min(44rem,94vw)]"
        data-testid="pipeline-picker-panel"
        @mouseleave="hoverId = undefined"
      >
        <!-- left: selectable options -->
        <ul class="w-1/2 shrink-0 overflow-y-auto border-e border-slate-800 p-1">
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-slate-800/60"
              :class="modelValue ? 'text-slate-300' : 'text-slate-100'"
              data-testid="pipeline-option-none"
              @mouseenter="hoverId = ''"
              @click="choose('')"
            >
              <UIcon name="i-lucide-rotate-ccw" class="h-4 w-4 shrink-0 text-slate-400" />
              <span class="flex-1 truncate">{{ noneLabel }}</span>
              <UIcon
                v-if="!modelValue"
                name="i-lucide-check"
                class="h-4 w-4 shrink-0 text-primary-400"
              />
            </button>
          </li>
          <li v-for="p in options" :key="p.id">
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-slate-800/60"
              :class="modelValue === p.id ? 'text-slate-100' : 'text-slate-300'"
              :data-testid="`pipeline-option-${p.id}`"
              @mouseenter="hoverId = p.id"
              @click="choose(p.id)"
            >
              <UIcon name="i-lucide-workflow" class="h-4 w-4 shrink-0 text-slate-400" />
              <span class="flex-1 truncate">{{ p.name }}</span>
              <UIcon
                v-if="modelValue === p.id"
                name="i-lucide-check"
                class="h-4 w-4 shrink-0 text-primary-400"
              />
            </button>
          </li>
        </ul>

        <!-- right: preview of the hovered (or selected) pipeline -->
        <div class="w-1/2 overflow-y-auto p-3">
          <PipelinePreview v-if="previewPipeline" :pipeline="previewPipeline" />
          <div v-else class="text-[12px] leading-snug text-slate-500">
            {{ t('pipeline.picker.noneHint') }}
          </div>
        </div>
      </div>
    </template>
  </UPopover>
</template>
