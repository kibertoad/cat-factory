<script setup lang="ts">
// The tool servers (MCP) one dispatch gave its agent, and the ones it declared and dropped.
// Recorded on the step at dispatch (`step.toolServers`); rendered only when a container dispatch
// recorded something, so an inline step shows nothing.
//
// The unavailable half is the reason this exists. A dropped server was, until now, stated in the
// agent's own prompt and in one backend warn line, and nowhere a person looks: a run that quietly
// went without its issue tracker read as a run whose agent simply did not use it. So an
// unavailable server is a chip of its own with its own translated reason, never a shorter list of
// the wired ones: "absent" and "zero" must not render the same.
import type { StepToolServers, ToolServerUnavailableReason } from '~/types/toolServers'
import { reasonText } from '~/components/panels/StepToolServers.logic'

defineProps<{ toolServers: StepToolServers }>()
const { t } = useI18n()

/** Bind this component's i18n instance onto the pure mapping (see `StepToolServers.logic.ts`). */
const describeReason = (reason: ToolServerUnavailableReason) =>
  reasonText(reason, (key, params) => t(key, params ?? {}))
</script>

<template>
  <section
    data-testid="step-tool-servers"
    class="scroll-mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4"
  >
    <div
      class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400"
    >
      <UIcon name="i-lucide-plug" class="h-3.5 w-3.5" />
      <span>{{ t('panels.stepDetail.toolServers.heading') }}</span>
    </div>

    <p
      v-if="!toolServers.wired.length && !toolServers.unavailable.length"
      class="text-[12px] text-slate-400"
    >
      {{ t('panels.stepDetail.toolServers.none') }}
    </p>

    <ul v-if="toolServers.wired.length" class="flex flex-wrap gap-1.5">
      <li
        v-for="server in toolServers.wired"
        :key="server.id"
        data-testid="step-tool-server-wired"
        class="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[12px] text-emerald-200"
        :title="
          server.tools?.length
            ? t('panels.stepDetail.toolServers.narrowed', { tools: server.tools.join(', ') })
            : t('panels.stepDetail.toolServers.allTools')
        "
      >
        <UIcon name="i-lucide-check" class="h-3.5 w-3.5" />
        <span>{{ server.label || server.id }}</span>
      </li>
    </ul>

    <ul v-if="toolServers.unavailable.length" class="mt-2 space-y-1">
      <li
        v-for="server in toolServers.unavailable"
        :key="server.id"
        data-testid="step-tool-server-unavailable"
        class="flex items-start gap-1.5 text-[12px] text-slate-300"
      >
        <UIcon name="i-lucide-plug-zap" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400/80" />
        <span>
          <span class="font-medium text-slate-200">{{ server.label || server.id }}</span>
          <span class="text-slate-400"> {{ describeReason(server.reason) }}</span>
        </span>
      </li>
    </ul>
  </section>
</template>
