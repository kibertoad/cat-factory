<script setup lang="ts" generic="T extends string">
// The ok/failure narrowing shared by the observability panel's two drill-downs (model calls and
// the tool-call trajectory).
//
// Every option carries its COUNT and stays rendered at zero. A chip that disappeared when its
// class was empty would answer "are there any failures?" by absence, which reads exactly like a
// list that has not finished loading — and "no tool call failed" is precisely the fact this
// panel exists to state out loud rather than imply.
const props = defineProps<{
  /** The options, in display order. `count` is what each would show if selected. */
  options: readonly { value: T; label: string; count: number; tone?: 'error' | 'warning' }[]
  modelValue: T
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T] }>()

/** Colour a chip by what it selects, so the failing one reads as failing even unselected. */
function toneClass(option: (typeof props.options)[number], active: boolean): string {
  if (active) return 'bg-slate-800 text-slate-100'
  if (option.count === 0) return 'text-slate-600 hover:text-slate-400'
  if (option.tone === 'error') return 'text-rose-400 hover:text-rose-300'
  if (option.tone === 'warning') return 'text-amber-400 hover:text-amber-300'
  return 'text-slate-400 hover:text-slate-200'
}
</script>

<template>
  <div class="flex rounded-lg border border-slate-800 p-0.5 text-[12px]">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="rounded-md px-2.5 py-1 transition"
      :class="toneClass(option, option.value === modelValue)"
      :aria-pressed="option.value === modelValue"
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
      <span class="tabular-nums opacity-70">{{ option.count }}</span>
    </button>
  </div>
</template>
