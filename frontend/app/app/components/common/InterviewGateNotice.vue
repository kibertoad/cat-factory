<script setup lang="ts">
// The shared "the interview is not waiting on you" panel, rendered by BOTH interview-gate windows
// (initiative planning, document interview) in place of the question list. It exists because those
// two states — a pass running, and a run that stopped before the interview settled — are the ones
// a window keyed on the interview entity alone cannot show at all, which is what made continue /
// proceed read as dead buttons. Copy is per-feature (passed in); the treatment is shared, so the
// two windows can't drift on how a wait or a failure looks. See
// `docs/initiatives/clarification-items.md`.
defineProps<{
  /** `working` = a pass is in flight (spinner); `failed` = the run stopped (error treatment). */
  variant: 'working' | 'failed'
  /** The headline, already localized by the calling window. */
  title: string
  /** The explanatory line under it, already localized. */
  hint: string
  /** The window's own `data-testid`, so each keeps a stable selector. */
  testid: string
}>()
</script>

<template>
  <div
    v-if="variant === 'working'"
    class="flex flex-col items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 p-6 text-center"
    :data-testid="testid"
  >
    <UIcon name="i-lucide-loader-circle" class="h-5 w-5 animate-spin text-indigo-300" />
    <p class="text-[13px] text-slate-200">{{ title }}</p>
    <p class="text-[12px] text-slate-400">{{ hint }}</p>
  </div>
  <div
    v-else
    class="rounded-lg border border-red-900/60 bg-red-950/20 p-4 text-center"
    :data-testid="testid"
  >
    <p class="text-[13px] text-red-200">{{ title }}</p>
    <p class="mt-1 text-[12px] text-slate-400">{{ hint }}</p>
  </div>
</template>
