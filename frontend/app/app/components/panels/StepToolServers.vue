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
// The wired half carries a SECOND answer when the run's harness reported one: what the agent's
// CLI said about each server when it started up. The two are deliberately not merged into one
// status — the platform withholding a tool and the CLI failing to start one are different faults
// for different people — and the absence of a CLI report renders as nothing at all, because
// "nobody looked" and "the CLI loaded nothing" are opposite facts and only silence states the
// first one honestly (a codex run, an older image and an unmapped runner pool all reach it).
//
// SELF-HIDING when the record holds nothing, like the sibling panels around it. The record is
// written on EVERY container dispatch, so both lists empty is the state of every step on every
// deployment that registers no tool servers at all — the overwhelming default. That state is a
// fact about the DECLARATION rather than about this run (the dispatched kind declares none), and
// the Infrastructure window is where declarations are read; rendering it here would put an empty
// section on every step of every run to say nothing happened. The distinction absent-vs-empty is
// still carried on the wire and answered by the debug API, which is where a reader asking it looks.
import type { StepToolServers } from '~/types/toolServers'
import {
  observationFor,
  observationIsFault,
  observationText,
  reasonText,
  remedyText,
  unattributedObservations,
} from '~/components/panels/StepToolServers.logic'
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

/**
 * Servers the CLI named that this dispatch did not wire. Empty on every ordinary run (the CLI runs
 * under `--strict-mcp-config`), and surfaced rather than filtered because the only way to reach it
 * is a report that describes some other job — which must not be presented as this job's clean bill
 * of health.
 */
const unattributed = computed(() => unattributedObservations(props.toolServers))

const hasAny = computed(
  () =>
    props.toolServers.wired.length > 0 ||
    props.toolServers.unavailable.length > 0 ||
    // A report about servers this dispatch did not wire is the one thing worth showing on an
    // otherwise empty record: both lists empty says the dispatched kind declared none, and a CLI
    // naming servers anyway contradicts exactly that.
    unattributed.value.length > 0,
)

/** Set only when a helper re-dispatch owns this record, so the ordinary case renders no extra line. */
const dispatchedAs = computed(() =>
  props.toolServers.agentKind && props.toolServers.agentKind !== props.stepAgentKind
    ? agentKindMeta(props.toolServers.agentKind).label
    : null,
)

/**
 * Each wired server with the CLI's own verdict joined onto it, when a verdict was reported. Bound
 * here for the same reason `drops` is: the join and the absent-vs-not-loaded decision are pure and
 * assertable without mounting, and resolving them once per record beats once per re-render.
 */
const wired = computed(() =>
  props.toolServers.wired.map((server) => {
    const observation = observationFor(props.toolServers.observed, server.id)
    return {
      ...server,
      observedText: observationText(observation, (key, params) => t(key, params ?? {})),
      isFault: observationIsFault(observation),
    }
  }),
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

    <ul v-if="wired.length" class="flex flex-wrap gap-1.5">
      <li
        v-for="server in wired"
        :key="server.id"
        data-testid="step-tool-server-wired"
        :data-observed-fault="server.isFault ? 'true' : undefined"
        class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px]"
        :class="
          server.isFault
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
            : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
        "
        :title="
          server.tools?.length
            ? t('panels.stepDetail.toolServers.narrowed', { tools: server.tools.join(', ') })
            : t('panels.stepDetail.toolServers.allTools')
        "
      >
        <UIcon
          :name="server.isFault ? 'i-lucide-triangle-alert' : 'i-lucide-check'"
          class="h-3.5 w-3.5"
        />
        <span>{{ server.label || server.id }}</span>
        <!--
          The CLI's own verdict, when the run's harness reported one. Absent renders NOTHING: a
          harness that publishes no report has said nothing about this server, and a placeholder
          would read as a verdict.
        -->
        <span
          v-if="server.observedText"
          data-testid="step-tool-server-observed"
          class="opacity-80"
          >{{ server.observedText }}</span
        >
      </li>
    </ul>

    <!--
      A report naming servers this dispatch did not wire can only come from a producer describing
      some other job (a runner-pool manifest mapped at the wrong field). Stated rather than
      filtered, so the rest of the report is not read as authoritative about this run.
    -->
    <ul v-if="unattributed.length" class="mt-2 space-y-1.5">
      <li
        v-for="server in unattributed"
        :key="server.id"
        data-testid="step-tool-server-unattributed"
        class="flex items-start gap-1.5 text-[12px] text-slate-400"
      >
        <UIcon name="i-lucide-circle-help" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{{
          t('panels.stepDetail.toolServers.observed.unattributed', { id: server.id })
        }}</span>
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
