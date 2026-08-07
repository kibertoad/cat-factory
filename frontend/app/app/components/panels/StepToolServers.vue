<script setup lang="ts">
// The tool servers (MCP) one dispatch gave its agent, and the ones it declared and dropped.
// Recorded on the step at dispatch (`step.toolServers`).
//
// The unavailable half is the reason this exists. A dropped server was, until now, stated in the
// agent's own prompt and in one backend warn line, and nowhere a person looks: a run that quietly
// went without its issue tracker read as a run whose agent simply did not use it. So an
// unavailable server is a chip of its own with its own translated reason, never a shorter list of
// the wired ones: "absent" and "zero" must not render the same.
//
// SELF-HIDING when the record holds nothing, like the sibling panels around it. The record is
// written on EVERY container dispatch, so both lists empty is the state of every step on every
// deployment that registers no tool servers at all — the overwhelming default. That state is a
// fact about the DECLARATION rather than about this run (the dispatched kind declares none), and
// the Infrastructure window is where declarations are read; rendering it here would put an empty
// section on every step of every run to say nothing happened. The distinction absent-vs-empty is
// still carried on the wire and answered by the debug API, which is where a reader asking it looks.
import type { StepToolServers } from '~/types/toolServers'
import { reasonText, remedyText } from '~/components/panels/StepToolServers.logic'
import { agentKindMeta } from '~/utils/catalog'

const props = defineProps<{
  toolServers: StepToolServers
  /**
   * The kind the STEP is named for. The record carries the kind that was DISPATCHED, and the two
   * differ whenever a helper ran on this step (a gate escalating to `ci-fixer`, the tester handing
   * off to `fixer`, a fork's second phase). Each of those resolves its own kind's declarations and
   * overwrites the record, so the surface names whose capabilities these are instead of letting
   * them read as the step's.
   */
  stepAgentKind: string
}>()

const { t } = useI18n()

const hasAny = computed(
  () => props.toolServers.wired.length > 0 || props.toolServers.unavailable.length > 0,
)

/** Set only when a helper re-dispatch owns this record, so the ordinary case renders no extra line. */
const dispatchedAs = computed(() =>
  props.toolServers.agentKind && props.toolServers.agentKind !== props.stepAgentKind
    ? agentKindMeta(props.toolServers.agentKind).label
    : null,
)

/**
 * Each dropped server with both halves of its answer resolved: WHY it was dropped, and what to
 * change so the next run gets it. Bound here rather than called from the template so the pure
 * mappings (`StepToolServers.logic.ts`) stay assertable without mounting a component, and so a
 * retired member's absent remedy is decided once instead of on every re-render.
 */
const drops = computed(() =>
  props.toolServers.unavailable.map((server) => ({
    ...server,
    reasonText: reasonText(server.reason, (key, params) => t(key, params ?? {})),
    remedy: remedyText(server.reason, (key, params) => t(key, params ?? {})),
  })),
)
</script>

<template>
  <section
    v-if="hasAny"
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
      v-if="dispatchedAs"
      data-testid="step-tool-servers-dispatched-as"
      class="mb-2 text-[12px] text-slate-400"
    >
      {{ t('panels.stepDetail.toolServers.dispatchedAs', { agent: dispatchedAs }) }}
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

    <ul v-if="drops.length" class="mt-2 space-y-1.5">
      <li
        v-for="server in drops"
        :key="server.id"
        data-testid="step-tool-server-unavailable"
        class="flex items-start gap-1.5 text-[12px] text-slate-300"
      >
        <UIcon name="i-lucide-plug-zap" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400/80" />
        <span>
          <span class="font-medium text-slate-200">{{ server.label || server.id }}</span>
          <span class="text-slate-400"> {{ server.reasonText }}</span>
          <!--
            Absent for a reason this build no longer recognises: it knows the code was recorded and
            not what it meant, so there is no surface it can honestly send an operator to.
          -->
          <span
            v-if="server.remedy"
            data-testid="step-tool-server-remedy"
            class="mt-0.5 block text-slate-500"
            >{{ server.remedy }}</span
          >
        </span>
      </li>
    </ul>
  </section>
</template>
