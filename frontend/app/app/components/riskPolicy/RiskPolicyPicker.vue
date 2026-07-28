<script setup lang="ts">
// The rich risk-policy picker used wherever a task's merge policy is chosen (add-task modal,
// inspector run settings). A master-detail popover mirroring <PipelinePicker>: the left column
// lists the policies by NAME ONLY (plus a "workspace default" row), and hovering a row reveals
// that policy's ceilings and what they mean in the right column. Cramming the thresholds into
// the option line itself made every row an unreadable run of abbreviated percentages; the
// detail pane is where they belong. The trigger is customizable via the `#trigger` slot (the
// inspector uses a bare icon button; the modal a full-width labelled one).
import { computed, ref } from 'vue'
import type { RiskPolicy } from '~/types/merge'
import RiskPolicyPreview from '~/components/riskPolicy/RiskPolicyPreview.vue'

const props = withDefaults(
  defineProps<{
    /** Selected policy id, or '' for the "workspace default" option. */
    modelValue: string
    /** The policies offered (the workspace's library). */
    options: RiskPolicy[]
    /** Label for the "workspace default" row (the consumer names the resolved default). */
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
// selected policy; the sentinel '' means the "workspace default" row is hovered.
const hoverId = ref<string | undefined>(undefined)

const selected = computed(() => props.options.find((p) => p.id === props.modelValue))
const triggerLabel = computed(() => selected.value?.name ?? props.noneLabel)

const defaultPolicy = computed(() => props.options.find((p) => p.isDefault) ?? null)

/**
 * The policy the right pane previews: the hovered row, else the current selection. Picking
 * NOTHING resolves to the workspace default at run time, so that row previews the default
 * policy rather than a bare hint — what the task would actually be governed by is the useful
 * answer. Only a workspace with no default at all falls back to the hint.
 */
const previewId = computed(() => hoverId.value ?? props.modelValue)
const previewPolicy = computed<RiskPolicy | null>(() =>
  previewId.value
    ? (props.options.find((p) => p.id === previewId.value) ?? null)
    : defaultPolicy.value,
)
/** True while the pane is previewing the default policy on behalf of the "none" row. */
const previewingFallback = computed(() => !previewId.value && !!previewPolicy.value)

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
        icon="i-lucide-git-merge"
        trailing-icon="i-lucide-chevron-down"
        :class="triggerClass"
        data-testid="risk-policy-picker-trigger"
      >
        {{ triggerLabel }}
      </UButton>
    </slot>

    <template #content>
      <div
        class="flex max-h-[24rem] w-[min(40rem,94vw)]"
        data-testid="risk-policy-picker-panel"
        @mouseleave="hoverId = undefined"
      >
        <!-- left: selectable options, NAME ONLY -->
        <ul class="w-1/2 shrink-0 overflow-y-auto border-e border-slate-800 p-1">
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-slate-800/60"
              :class="modelValue ? 'text-slate-300' : 'text-slate-100'"
              data-testid="risk-policy-option-none"
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
              :data-testid="`risk-policy-option-${p.id}`"
              @mouseenter="hoverId = p.id"
              @click="choose(p.id)"
            >
              <UIcon name="i-lucide-git-merge" class="h-4 w-4 shrink-0 text-slate-400" />
              <span class="flex-1 truncate">{{ p.name }}</span>
              <UIcon
                v-if="modelValue === p.id"
                name="i-lucide-check"
                class="h-4 w-4 shrink-0 text-primary-400"
              />
            </button>
          </li>
        </ul>

        <!-- right: what the hovered (or selected) policy actually does -->
        <div class="w-1/2 overflow-y-auto p-3">
          <template v-if="previewPolicy">
            <p v-if="previewingFallback" class="mb-2 text-[11px] leading-snug text-slate-500">
              {{ t('riskPolicy.picker.workspaceDefaultCaption') }}
            </p>
            <RiskPolicyPreview :policy="previewPolicy" />
          </template>
          <div v-else class="text-[12px] leading-snug text-slate-500">
            {{ t('riskPolicy.picker.noneHint') }}
          </div>
        </div>
      </div>
    </template>
  </UPopover>
</template>
