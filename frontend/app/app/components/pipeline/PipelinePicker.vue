<script setup lang="ts">
// The rich pipeline picker used wherever a pipeline is chosen — as a stored default (add-task
// modal, inspector run settings, the recurring-schedule modal) or as an immediate action (the
// focus view's Run menu). A master–detail popover: the left column lists the selectable pipelines
// (plus an optional "none / choose at run time" row), and hovering a row reveals that pipeline's
// full preview — its description and every step it will run, in order — in the right column, so a
// user sees exactly what a pipeline does before picking it. The trigger is customizable via the
// `#trigger` slot (the inspector uses a bare icon button; the modal a full-width labelled one).
import { computed, ref } from 'vue'
import type { Pipeline } from '~/types/domain'

const props = withDefaults(
  defineProps<{
    /** Selected pipeline id, or '' for none. An action-mode caller passes a constant ''. */
    modelValue: string
    /** The pipelines offered (already filtered for the surface, e.g. manual-start allowed). */
    options: Pipeline[]
    /**
     * Label for the "none" row (e.g. "Choose at run time" / "No default"). Omit where picking
     * nothing is not a valid outcome — a schedule needs a pipeline, and a Run menu acts on the
     * chosen row — and the row is left out entirely.
     */
    noneLabel?: string
    /**
     * Default-trigger text while nothing is selected. Defaults to {@link noneLabel}, which reads
     * correctly when the "none" row IS the empty state; a surface without that row supplies its
     * own prompt ("Pick a pipeline").
     */
    placeholder?: string
    /** Extra classes for the default trigger button (e.g. full-width in the modal). */
    triggerClass?: string
  }>(),
  { noneLabel: undefined, placeholder: undefined, triggerClass: '' },
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()
const { t } = useI18n()

const open = ref(false)
// The row currently hovered, driving the right-column preview. `undefined` ⇒ fall back to the
// selected pipeline; the sentinel '' means the "none" row is hovered (show the none hint).
const hoverId = ref<string | undefined>(undefined)

const selected = computed(() => props.options.find((p) => p.id === props.modelValue))
const triggerLabel = computed(
  () => selected.value?.name ?? props.placeholder ?? props.noneLabel ?? '',
)

/** The pipeline the right pane previews: the hovered row, else the current selection. */
const previewPipeline = computed<Pipeline | null>(() => {
  const id = hoverId.value ?? props.modelValue
  return id ? (props.options.find((p) => p.id === id) ?? null) : null
})

/**
 * With no pipeline to preview the pane explains WHY it's empty, and the two reasons differ: the
 * "none" row is a real choice worth describing, while a picker without one is simply waiting for
 * a hover. Sharing one hint would tell a Run menu it has no default pipeline, which is nonsense.
 */
const emptyHint = computed(() =>
  props.noneLabel !== undefined && (hoverId.value ?? props.modelValue) === ''
    ? t('pipeline.picker.noneHint')
    : t('pipeline.picker.hoverHint'),
)

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
        class="flex max-h-[28rem] w-[min(44rem,94vw)]"
        data-testid="pipeline-picker-panel"
        @mouseleave="hoverId = undefined"
      >
        <!-- left: selectable options -->
        <ul class="w-1/2 shrink-0 overflow-y-auto border-e border-slate-800 p-1">
          <li v-if="noneLabel !== undefined">
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
          <div v-else class="text-[12px] leading-snug text-slate-500">{{ emptyHint }}</div>
        </div>
      </div>
    </template>
  </UPopover>
</template>
