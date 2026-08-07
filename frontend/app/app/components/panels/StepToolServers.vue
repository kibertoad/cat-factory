<script setup lang="ts">
import { computed } from 'vue'
import type { DispatchedToolServer } from '~/types/toolServers'
import { toolServerRows } from '~/utils/toolServers'

// The tool servers (MCP) one dispatch wired into its agent's CLI, and the ones it declared and
// could not, each with the reason.
//
// Takes the LIST rather than a step because the same record reaches a reader from two stores: the
// run's own step (the metadata card, beside the model and the container: "what actually ran") and
// the agent-context telemetry snapshot (the observability panel, where it used to be a line in a
// JSON dump). Before either, a dispatch that dropped a server told exactly two readers: the
// agent, in a prompt line telling it to plan without the tool, and a backend `warn`. So the
// operator-visible symptom of a missing credential was an agent that simply never used the tool.
//
// Self-hides on an empty list, which is what a kind declaring no tool servers records: an empty
// section on every step of every run would say something false about a deployment that registered
// none.
const props = defineProps<{ servers: readonly DispatchedToolServer[] }>()
const { t } = useI18n()

const rows = computed(() => toolServerRows(props.servers))
const unavailable = computed(() => rows.value.filter((row) => row.status !== 'wired').length)
</script>

<template>
  <div v-if="rows.length" data-testid="step-tool-servers">
    <div
      class="text-[11px] uppercase tracking-wide text-slate-500"
      :title="t('panels.stepMeta.toolServers.hint')"
    >
      {{ t('panels.stepMeta.toolServers.heading') }}
      <span v-if="unavailable" class="ms-1 text-amber-400/80">
        {{ t('panels.stepMeta.toolServers.unavailableCount', { count: unavailable }, unavailable) }}
      </span>
    </div>
    <ul class="mt-1.5 space-y-1.5">
      <li
        v-for="row in rows"
        :key="row.id"
        class="flex items-start gap-2 text-[12px]"
        data-testid="step-tool-server"
      >
        <UIcon
          :name="row.status === 'wired' ? 'i-lucide-plug-zap' : 'i-lucide-unplug'"
          class="mt-px h-3.5 w-3.5 shrink-0"
          :class="row.status === 'wired' ? 'text-emerald-400' : 'text-amber-400'"
        />
        <div class="min-w-0">
          <span class="text-slate-200">{{ row.label }}</span>
          <span
            class="ms-1.5 rounded px-1.5 py-0.5 text-[11px]"
            :class="
              row.status === 'wired'
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/15 text-amber-300'
            "
          >
            <template v-if="row.status === 'wired'">
              {{ t('panels.stepMeta.toolServers.wired') }}
            </template>
            <template v-else-if="row.keys">{{ t(row.keys.chip) }}</template>
            <template v-else>{{ t('panels.stepMeta.toolServers.reason.unknown') }}</template>
          </span>
          <!-- The remedy names what to CHANGE, which is the whole reason the drop vocabulary is
               split the way it is. An unrecognised reason renders verbatim rather than as a blank:
               the value is persisted on the run, so a step recorded before a member was retired
               still arrives here carrying it. -->
          <p v-if="row.status !== 'wired'" class="mt-0.5 text-[11px] text-slate-400">
            <template v-if="row.keys">{{ t(row.keys.remedy) }}</template>
            <template v-else>
              {{ t('panels.stepMeta.toolServers.remedy.unknown', { reason: row.rawReason }) }}
            </template>
          </p>
        </div>
      </li>
    </ul>
  </div>
</template>
