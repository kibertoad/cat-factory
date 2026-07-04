<script setup lang="ts">
// Shared header row for an attempt-timeline entry. The polling-gate helper attempts
// (GateResultView) and the Tester's fixer rounds (TestReportWindow) render the same chrome —
// a leading label, an outcome badge, and a timestamp — differing only in the optional icon,
// the resolved label strings, and the date format. The per-attempt body stays the caller's.
defineProps<{
  label: string
  outcome: 'completed' | 'failed'
  outcomeLabel: string
  at?: number | null
  dateFormat?: 'short' | 'long'
  icon?: string
  iconClass?: string
}>()

const { d } = useI18n()

function formatClock(ms: number | null | undefined, fmt: 'short' | 'long'): string | null {
  return ms ? d(new Date(ms), fmt) : null
}
</script>

<template>
  <div class="flex items-center gap-2">
    <UIcon v-if="icon" :name="icon" class="h-3.5 w-3.5 shrink-0" :class="iconClass" />
    <span class="text-[13px] font-medium text-slate-200">{{ label }}</span>
    <UBadge :color="outcome === 'failed' ? 'error' : 'neutral'" variant="subtle" size="sm">{{
      outcomeLabel
    }}</UBadge>
    <span
      v-if="formatClock(at, dateFormat ?? 'short')"
      class="ms-auto text-[11px] text-slate-500"
      >{{ formatClock(at, dateFormat ?? 'short') }}</span
    >
  </div>
</template>
