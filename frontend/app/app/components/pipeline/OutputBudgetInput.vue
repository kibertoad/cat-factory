<script setup lang="ts">
/**
 * The output-token ceiling control, shared by both tiers that configure one: a pipeline step's
 * own override (in the builder) and a workspace's per-agent-kind default (in the prompt editor).
 *
 * Empty means INHERIT, and that is the whole reason this is a component rather than a bare
 * `UInput type="number"` at each call site: "no value" has to round-trip as `null` and never as
 * `0`, or clearing the field would send a zero-token ceiling — every reply empty — instead of
 * falling back to the next tier. The bounds come from the contract, so the input cannot offer a
 * value the server would reject.
 */
import { computed } from 'vue'
import { MAX_AGENT_MAX_OUTPUT_TOKENS, MIN_AGENT_MAX_OUTPUT_TOKENS } from '~/types/agent-settings'

const props = defineProps<{
  /** The configured ceiling, or null/undefined when this tier inherits. */
  modelValue: number | null | undefined
  /** What this tier falls back to, shown as the placeholder so "inherit" names a number. */
  inheritedValue?: number | undefined
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [number | null] }>()

const { t, n } = useI18n()

/** Bound to the input as a string so an empty field is distinguishable from a typed 0. */
const text = computed(() => (props.modelValue != null ? String(props.modelValue) : ''))

/**
 * The placeholder names the inherited ceiling when the caller knows it, so a user reading an
 * empty field learns what the step will actually run on rather than just that it is unset.
 */
const placeholder = computed(() =>
  props.inheritedValue != null
    ? t('pipeline.outputBudget.inheritsValue', { tokens: n(props.inheritedValue) })
    : t('pipeline.outputBudget.inherits'),
)

/**
 * Commit on change. An empty/unparseable field clears to `null` (inherit); anything else is
 * clamped into the contract's range rather than rejected, so a fat-fingered extra digit lands on
 * the ceiling instead of silently failing the save with a 422.
 */
function commit(raw: string | number) {
  const trimmed = String(raw).trim()
  if (trimmed === '') return emit('update:modelValue', null)
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed)) return emit('update:modelValue', null)
  const clamped = Math.min(
    MAX_AGENT_MAX_OUTPUT_TOKENS,
    Math.max(MIN_AGENT_MAX_OUTPUT_TOKENS, parsed),
  )
  emit('update:modelValue', clamped)
}
</script>

<template>
  <UInput
    :model-value="text"
    type="number"
    size="xs"
    :min="MIN_AGENT_MAX_OUTPUT_TOKENS"
    :max="MAX_AGENT_MAX_OUTPUT_TOKENS"
    :placeholder="placeholder"
    :disabled="disabled"
    @change="commit(($event.target as HTMLInputElement).value)"
  />
</template>
