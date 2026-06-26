<script setup lang="ts">
// The "View logs" surface for a provisioning subsystem: every attempt to spin up /
// tear down infrastructure (environment provider, or runner-pool/container), with its
// outcome and — for failures — the verbatim provider/runtime error. Loaded on mount
// (and re-loadable) from the unified provisioning event log.
import { onMounted } from 'vue'
import type { ProvisioningOperation, ProvisioningSubsystem } from '~/types/provisioningLogs'

const props = defineProps<{ subsystem: ProvisioningSubsystem }>()

const store = useProvisioningLogsStore()
const state = computed(() => store.bySubsystem[props.subsystem])

onMounted(() => store.load(props.subsystem))

const OPERATION_LABEL: Record<ProvisioningOperation, string> = {
  provision: 'Spin up',
  teardown: 'Tear down',
  status: 'Status check',
  dispatch: 'Spin up',
  release: 'Tear down',
  'poll-failure': 'Health check',
}

function when(epochMs: number): string {
  return new Date(epochMs).toLocaleString()
}
</script>

<template>
  <div class="rounded-lg border border-slate-700 bg-slate-900/50">
    <div class="flex items-center justify-between border-b border-slate-800 px-3 py-2">
      <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Provisioning logs
      </p>
      <UButton
        icon="i-lucide-rotate-ccw"
        variant="ghost"
        size="xs"
        :loading="state.loading"
        @click="store.load(props.subsystem)"
      >
        Refresh
      </UButton>
    </div>

    <p v-if="state.error" class="px-3 py-2 text-[12px] text-rose-300">{{ state.error }}</p>
    <p
      v-else-if="!state.loading && state.entries.length === 0"
      class="px-3 py-3 text-[12px] text-slate-500"
    >
      No provisioning attempts recorded yet.
    </p>

    <ul v-else class="max-h-80 divide-y divide-slate-800 overflow-auto">
      <li v-for="entry in state.entries" :key="entry.id" class="px-3 py-2">
        <div class="flex items-center gap-2 text-[12px]">
          <UIcon
            :name="entry.outcome === 'success' ? 'i-lucide-check-circle' : 'i-lucide-x-circle'"
            class="h-3.5 w-3.5 shrink-0"
            :class="entry.outcome === 'success' ? 'text-emerald-400' : 'text-rose-400'"
          />
          <span class="font-medium text-slate-200">{{ OPERATION_LABEL[entry.operation] }}</span>
          <span
            class="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
            :class="
              entry.outcome === 'success'
                ? 'bg-emerald-950/60 text-emerald-300'
                : 'bg-rose-950/60 text-rose-300'
            "
            >{{ entry.outcome }}</span
          >
          <span class="ml-auto text-[11px] text-slate-500">{{ when(entry.createdAt) }}</span>
        </div>
        <div v-if="entry.targetId" class="mt-0.5 text-[11px] text-slate-500">
          {{ entry.providerId ? `${entry.providerId} · ` : '' }}{{ entry.targetId }}
        </div>
        <!-- The verbatim provider/runtime error on a failed attempt. -->
        <pre
          v-if="entry.error"
          class="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded border border-rose-900/50 bg-rose-950/30 p-1.5 text-[11px] text-rose-200/90"
          >{{ entry.error }}</pre
        >
      </li>
    </ul>
  </div>
</template>
