<script setup lang="ts">
/**
 * The one-line state of the WHOLE-RUN fetch a step-detail surface depends on.
 *
 * The board snapshot carries a lean projection of every run: each step's captured prose is
 * WITHHELD, not absent (`projectExecutionForBoard`). A window that renders that prose asks the
 * store for the whole run on open, and until that read lands (or when it fails) the surface has
 * nothing to say about the prose. Both states have to be visible, because an empty reader and a
 * failed fetch look identical and only one of them means "this step said nothing".
 *
 * Renders nothing for a run the store already holds whole, which is every run a live `execution`
 * event delivered and every run already fetched once.
 */
import { computed } from 'vue'

const props = defineProps<{ instanceId: string | null }>()

const execution = useExecutionStore()
const { t } = useI18n()

const loading = computed(() => execution.isFullPending(props.instanceId))
const error = computed(() => execution.fullError(props.instanceId))
</script>

<template>
  <div
    v-if="loading || error"
    class="flex items-center gap-2 border-b border-slate-800 px-4 py-2 text-[11px]"
    :class="error ? 'text-rose-300' : 'text-slate-400'"
    data-testid="run-detail-load-state"
  >
    <UIcon
      :name="error ? 'i-lucide-triangle-alert' : 'i-lucide-loader-circle'"
      class="h-3.5 w-3.5 shrink-0"
      :class="error ? '' : 'animate-spin'"
    />
    <span>{{
      error ? t('panels.runDetail.loadFailed', { reason: error }) : t('panels.runDetail.loading')
    }}</span>
  </div>
</template>
