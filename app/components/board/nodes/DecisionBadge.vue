<script setup lang="ts">
defineProps<{
  count?: number
  compact?: boolean
}>()
defineEmits<{ (e: 'open'): void }>()
</script>

<template>
  <button
    type="button"
    class="board-pulse flex items-center gap-1 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-amber-950 shadow-lg transition hover:bg-amber-400"
    @click.stop="$emit('open')"
  >
    <UIcon name="i-lucide-circle-help" class="h-3.5 w-3.5" />
    <span v-if="!compact">Decision needed</span>
    <span v-if="count && count > 1" class="rounded-full bg-amber-950/30 px-1">
      {{ count }}
    </span>
  </button>
</template>
