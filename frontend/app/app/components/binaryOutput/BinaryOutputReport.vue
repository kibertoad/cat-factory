<script setup lang="ts">
// What a BINARY-OUTPUT step delivered: the artifacts it declared it stored through the
// foundational service the step selected, and — with equal weight — every way that record is
// incomplete. See docs/initiatives/binary-output-foundational-storage.md.
//
// The engine's parse keeps six outcomes apart on purpose (not started, still running, no
// declaration, an unreadable one, an explicit "stored nothing", and actual artifacts), because
// each needs a different reaction and five of them are NOT "an empty list". This renders the
// discriminant `binaryOutputView` derives, never a list that happens to be empty.
//
// It is a plain presenter over the STEP's own record — no fetch, no catalog read — so it drops
// into both of the surfaces a step opens on (the result-window shell's trailing section and the
// generic step-detail panel) and reads identically on a run whose services were withdrawn since.
import { computed } from 'vue'
import type { PipelineStep } from '~/types/execution'
import { BINARY_OUTPUT_STATE_KEYS, binaryOutputView } from '~/utils/binaryOutput'
import CopyButton from '~/components/common/CopyButton.vue'

// Two callers, one renderer — the same split `StepEffortReport` makes: the generic step-detail
// panel drops it in as a `card` (its own heading + border, among the other detail sections),
// and `ResultWindowShell`'s collapsible footer embeds it `flat`, where the disclosure row is
// already the heading and a second one would be chrome inside chrome.
const props = withDefaults(defineProps<{ step: PipelineStep; variant?: 'card' | 'flat' }>(), {
  variant: 'flat',
})
const { t } = useI18n()

const view = computed(() => binaryOutputView(props.step))

/**
 * The outcome's own copy, from the shared exhaustive map — shared so the collapsed section row
 * above this panel and the sentence inside it can never claim different outcomes. `stored`
 * carries no detail (the artifacts are the statement), so it falls back to its summary.
 */
const state = computed(() => {
  const keys = BINARY_OUTPUT_STATE_KEYS[view.value?.state ?? 'configured']
  return { ...keys, text: t(keys.detail || keys.summary) }
})
</script>

<template>
  <section
    v-if="view"
    class="space-y-3"
    :class="
      variant === 'card' ? 'scroll-mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4' : ''
    "
    data-testid="binary-output-report"
  >
    <div
      v-if="variant === 'card'"
      class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400"
    >
      <UIcon name="i-lucide-image" class="h-3.5 w-3.5" />
      <span>{{ t('binaryOutput.heading') }}</span>
    </div>

    <!-- What happened, in one sentence, before any list. Four of the five states have no list
         at all, and the fifth still needs its qualifications read alongside it. -->
    <p
      class="flex items-start gap-2 text-[12px] leading-relaxed"
      :class="state.tone"
      data-testid="binary-output-state"
      :data-state="view.state"
    >
      <UIcon :name="state.icon" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{{ state.text }}</span>
    </p>

    <!-- The step's own selection: the target every artifact was supposed to go through, and
         the services it was told to scope the generation from. A step with NO selection says
         so — it is a real state (a trait-carrying kind dispatched under an overriding kind
         records a declaration against a step that never held one), and rendering a blank
         would read as a missing value rather than an absent comparison. -->
    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
      <dt class="text-slate-500">{{ t('binaryOutput.target') }}</dt>
      <dd
        v-if="view.target"
        class="min-w-0 font-mono text-slate-300"
        data-testid="binary-output-target"
      >
        {{ view.target }}
      </dd>
      <dd v-else class="min-w-0 text-slate-400" data-testid="binary-output-target">
        {{ t('binaryOutput.targetNone') }}
      </dd>
      <template v-if="view.contextServices.length">
        <dt class="text-slate-500">{{ t('binaryOutput.contextServices') }}</dt>
        <dd class="min-w-0 font-mono text-slate-400">{{ view.contextServices.join(', ') }}</dd>
      </template>
    </dl>

    <!-- The artifacts. `location` is the service's OWN addressing — an object key, a path, a
         URL — recorded verbatim and never interpreted, so it renders as copyable text and
         never as a link. -->
    <ul v-if="view.rows.length" class="space-y-1.5">
      <li
        v-for="(row, i) in view.rows"
        :key="`${row.service}:${row.location}:${i}`"
        class="relative rounded-md border border-slate-800 bg-slate-950/40 px-2.5 py-2"
        data-testid="binary-output-artifact"
      >
        <CopyButton :text="row.location" class="absolute end-1 top-1" />
        <code class="block break-all pe-8 font-mono text-[11px] text-slate-200">{{
          row.location
        }}</code>
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-slate-500">
          <span class="font-mono">{{ row.service }}</span>
          <!-- The join the report cannot make on its own, and the question a human opens this
               for: did it go where the step pointed it? -->
          <UBadge
            v-if="row.misdirected"
            color="warning"
            variant="subtle"
            size="sm"
            data-testid="binary-output-misdirected"
          >
            {{ t('binaryOutput.misdirectedBadge') }}
          </UBadge>
          <UBadge
            v-if="row.unknown"
            color="warning"
            variant="subtle"
            size="sm"
            data-testid="binary-output-unknown-badge"
          >
            {{ t('binaryOutput.unknownBadge') }}
          </UBadge>
          <span v-if="row.entity">{{ row.entity }}</span>
          <span v-if="row.contentType" class="font-mono">{{ row.contentType }}</span>
        </div>
        <p v-if="row.description" class="mt-1 text-[11px] leading-relaxed text-slate-400">
          {{ row.description }}
        </p>
      </li>
    </ul>

    <!-- Every qualification the report counted, each naming its own number. Never folded into
         one "some entries were dropped": the fix for an unknown service id is not the fix for
         a malformed entry, and neither is the fix for a list that stops short of the tail. -->
    <ul class="space-y-1 text-[11px] text-amber-400">
      <!-- The step's OWN target went missing from the catalog, and an id the AGENT invented,
           are two different failures with two different fixes (re-register it, versus correct
           the declaration). `binaryOutputView` returns them as DISJOINT fields precisely so
           these can be two independent lines: sharing one line meant the lost target's message
           named every unknown id as if it were the step's own service, and silently dropped
           the invented ones. -->
      <li v-if="view.targetUnknown" data-testid="binary-output-target-unknown">
        {{ t('binaryOutput.warning.targetUnknown', { id: view.target }) }}
      </li>
      <li v-if="view.unknownDeclaredServices.length" data-testid="binary-output-unknown-services">
        {{
          t(
            'binaryOutput.warning.unknownServices',
            {
              ids: view.unknownDeclaredServices.join(', '),
              count: view.unknownDeclaredServices.length,
            },
            view.unknownDeclaredServices.length,
          )
        }}
      </li>
      <li v-if="view.misdirected" data-testid="binary-output-misdirected-note">
        {{
          t(
            'binaryOutput.warning.misdirected',
            { count: view.misdirected, target: view.target },
            view.misdirected,
          )
        }}
      </li>
      <li v-if="view.invalidEntries" data-testid="binary-output-invalid">
        {{
          t(
            'binaryOutput.warning.invalidEntries',
            { count: view.invalidEntries },
            view.invalidEntries,
          )
        }}
      </li>
      <li v-if="view.omitted" data-testid="binary-output-omitted">
        {{ t('binaryOutput.warning.omitted', { count: view.omitted }, view.omitted) }}
      </li>
    </ul>
  </section>
</template>
