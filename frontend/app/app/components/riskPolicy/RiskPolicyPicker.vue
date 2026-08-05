<script setup lang="ts">
// The rich risk-policy picker used wherever a task's merge policy is chosen (add-task modal,
// inspector run settings). A master-detail popover mirroring <PipelinePicker>: the left column
// lists the policies by NAME ONLY (plus a "workspace default" row), and hovering a row reveals
// that policy's ceilings and what they mean in the right column. Cramming the thresholds into
// the option line itself made every row an unreadable run of abbreviated percentages; the
// detail pane is where they belong. The trigger is customizable via the `#trigger` slot (the
// inspector uses a bare icon button; the modal a full-width labelled one).
//
// The detail pane follows FOCUS as well as the pointer. Moving the numbers off the option
// line would otherwise put them out of reach of anyone driving the list from the keyboard,
// who never fires a `mouseenter` — the thresholds are the whole point of the pane, so they
// cannot be pointer-only.
import { computed, ref } from 'vue'
import type { RiskPolicy } from '~/types/merge'
import RiskPolicyPreview from '~/components/riskPolicy/RiskPolicyPreview.vue'
import {
  refusedRiskPolicySelections,
  resolveRiskPolicyPicker,
} from '~/components/riskPolicy/RiskPolicyPicker.logic'

const props = withDefaults(
  defineProps<{
    /** Selected policy id, or '' for the "workspace default" option. */
    modelValue: string
    /** The policies offered (the workspace's library). */
    options: RiskPolicy[]
    /**
     * The workspace default a task picking nothing is governed by, resolved by the consumer
     * (which already reads it off the store to build `noneLabel`) so the two can't disagree.
     */
    defaultPolicy: RiskPolicy | null
    /** Label for the "workspace default" row (the consumer names the resolved default). */
    noneLabel: string
    /** Extra classes for the default trigger button (e.g. full-width in the modal). */
    triggerClass?: string
  }>(),
  { triggerClass: '' },
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()
const { t } = useI18n()
const access = useWorkspaceAccess()

const open = ref(false)
// The row the pointer or the keyboard is currently on, driving the right-column preview.
// `undefined` ⇒ fall back to the selected policy; the sentinel '' means the "workspace
// default" row is active.
const activeId = ref<string | undefined>(undefined)

const selected = computed(() => props.options.find((p) => p.id === props.modelValue))
const triggerLabel = computed(() => selected.value?.name ?? props.noneLabel)

const preview = computed(() =>
  resolveRiskPolicyPicker({
    options: props.options,
    defaultPolicy: props.defaultPolicy,
    modelValue: props.modelValue,
    activeId: activeId.value,
  }),
)

/**
 * The policies this user may not move THIS task to, and why (ADR 0037): a selection may not
 * relax what the selector's own role is held to, and the backend refuses one that does. Offering
 * the row anyway would be telling someone they made a choice the engine then discards.
 *
 * Empty on every workspace whose policies treat each initiator alike (which is every built-in),
 * and always empty for someone holding `settings.manage`, who owns the library.
 */
const refused = computed(() =>
  refusedRiskPolicySelections({
    options: props.options,
    defaultPolicy: props.defaultPolicy,
    modelValue: props.modelValue,
    actor: { role: access.role.value, managesPolicy: access.canManageSettings.value },
  }),
)

/** The reason the previewed row is refused, if it is: the pane explains what the row cannot. */
const previewRefusal = computed(() => refused.value.get(activeId.value ?? props.modelValue))

/**
 * The same reason as a tooltip on the row itself, `undefined` when the row is selectable.
 *
 * A refused row is `aria-disabled`, NOT `disabled`: a disabled button is unfocusable, so keyboard
 * users could never land on it, and landing on it is precisely what puts the reason in the detail
 * pane (the `@focus` handler below drives the preview). Refusing the click is `choose`'s job, so
 * the row stays reachable by both routes and explains itself on both.
 */
function refusalText(id: string): string | undefined {
  const refusal = refused.value.get(id)
  return refusal ? t(`riskPolicy.picker.refused.${refusal}`) : undefined
}

/**
 * Tabbing BETWEEN two rows fires `focusout` on the one being left, so only focus leaving the
 * panel altogether may drop the preview back to the selection.
 */
function onPanelFocusOut(event: FocusEvent) {
  const panel = event.currentTarget
  const next = event.relatedTarget
  if (panel instanceof Node && next instanceof Node && panel.contains(next)) return
  activeId.value = undefined
}

function choose(id: string) {
  if (refused.value.has(id)) return
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
        @mouseleave="activeId = undefined"
        @focusout="onPanelFocusOut"
      >
        <!-- left: selectable options, NAME ONLY -->
        <ul class="w-1/2 shrink-0 overflow-y-auto border-e border-slate-800 p-1">
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm"
              :class="[
                refused.has('') ? 'cursor-not-allowed opacity-50' : 'hover:bg-slate-800/60',
                modelValue ? 'text-slate-300' : 'text-slate-100',
              ]"
              :aria-disabled="refused.has('')"
              :title="refusalText('')"
              data-testid="risk-policy-option-none"
              @mouseenter="activeId = ''"
              @focus="activeId = ''"
              @click="choose('')"
            >
              <UIcon
                :name="refused.has('') ? 'i-lucide-lock' : 'i-lucide-rotate-ccw'"
                class="h-4 w-4 shrink-0 text-slate-400"
              />
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
              class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm"
              :class="[
                refused.has(p.id) ? 'cursor-not-allowed opacity-50' : 'hover:bg-slate-800/60',
                modelValue === p.id ? 'text-slate-100' : 'text-slate-300',
              ]"
              :aria-disabled="refused.has(p.id)"
              :title="refusalText(p.id)"
              :data-testid="`risk-policy-option-${p.id}`"
              @mouseenter="activeId = p.id"
              @focus="activeId = p.id"
              @click="choose(p.id)"
            >
              <UIcon
                :name="refused.has(p.id) ? 'i-lucide-lock' : 'i-lucide-git-merge'"
                class="h-4 w-4 shrink-0 text-slate-400"
              />
              <span class="flex-1 truncate">{{ p.name }}</span>
              <UIcon
                v-if="modelValue === p.id"
                name="i-lucide-check"
                class="h-4 w-4 shrink-0 text-primary-400"
              />
            </button>
          </li>
        </ul>

        <!-- right: what the active (or selected) policy actually does -->
        <div class="w-1/2 overflow-y-auto p-3">
          <template v-if="preview.policy">
            <p
              v-if="previewRefusal"
              class="mb-2 text-[11px] leading-snug text-amber-400"
              data-testid="risk-policy-refusal"
            >
              {{ t(`riskPolicy.picker.refused.${previewRefusal}`) }}
            </p>
            <p
              v-if="preview.viaWorkspaceDefault"
              class="mb-2 text-[11px] leading-snug text-slate-500"
            >
              {{ t('riskPolicy.picker.workspaceDefaultCaption') }}
            </p>
            <RiskPolicyPreview :policy="preview.policy" />
          </template>
          <div v-else class="text-[12px] leading-snug text-slate-500">
            {{ t('riskPolicy.picker.noneHint') }}
          </div>
        </div>
      </div>
    </template>
  </UPopover>
</template>
