<script setup lang="ts">
// Shared renderer for a gate's failing-check list (`gateFailingCheckSchema[]`): each check
// links to its GitHub run when a URL is known, with its conclusion. Used by BOTH the CI
// gate's precheck panel and each per-attempt "handed to the fixer" list in GateResultView,
// so the link + conclusion-fallback logic lives in one place (they had drifted — the
// per-attempt copy silently dropped the GitHub link).
import type { GateFailingCheck } from '~/types/execution'

defineProps<{
  checks: GateFailingCheck[]
  // Compact layout for the per-attempt timeline; the fuller card layout is the default
  // (the precheck panel).
  dense?: boolean
}>()

const { t } = useI18n()
</script>

<template>
  <ul :class="dense ? 'space-y-0.5' : 'space-y-1'">
    <li
      v-for="(c, i) in checks"
      :key="`${c.name}-${i}`"
      class="flex items-center"
      :class="
        dense ? 'gap-1.5' : 'gap-2 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-1.5'
      "
    >
      <UIcon
        name="i-lucide-circle-x"
        class="shrink-0 text-rose-400"
        :class="dense ? 'h-3 w-3' : 'h-3.5 w-3.5'"
      />
      <a
        v-if="c.url"
        :href="c.url"
        target="_blank"
        rel="noopener"
        class="group min-w-0 flex-1 truncate text-sky-300 hover:text-sky-200 hover:underline"
        :class="dense ? 'text-[12px]' : 'text-[13px]'"
        :title="t('gates.ci.openOnGithub', { name: c.name })"
      >
        {{ c.name }}
        <UIcon
          name="i-lucide-external-link"
          class="ms-0.5 inline h-3 w-3 opacity-60 group-hover:opacity-100"
        />
      </a>
      <span
        v-else
        class="min-w-0 flex-1 truncate"
        :class="dense ? 'text-[12px] text-slate-300' : 'text-[13px] text-slate-200'"
        >{{ c.name }}</span
      >
      <span
        class="shrink-0 uppercase text-rose-300"
        :class="dense ? 'text-[10px]' : 'text-[11px]'"
        >{{ c.conclusion ?? t('gates.ci.conclusionFallback') }}</span
      >
    </li>
  </ul>
</template>
