<script setup lang="ts">
// A WORKED EXAMPLE of a CONSUMER-shipped inspector body panel. Contributed to the layer's
// `inspectorPanels` slot (see `~/modular/acme-security.ts`) with a `when(block)` predicate,
// so `<PanelsOutlet>` in the layer's `InspectorPanel.vue` renders it for matching blocks
// with ZERO host edits — the same seam the first-party inspector panels use.
//
// It reuses the layer's shared `<InspectorSection>` chrome — referenced through the
// `#components` virtual module (Nuxt's stable registry of the layer's auto-imported
// components) rather than a deep path into the layer internals — so a consumer panel reads
// exactly like a built-in one, and reads the selected block via the subject-keyed panels
// primitive `usePanelSubject` (`@modular-vue/core`). (A bare `<InspectorSection>` tag would
// silently fail in a CONSUMER SFC: Nuxt registers the layer component under its path-derived
// name `PanelsInspectorSection`, and only in-scope layer SFCs get their bare tags rewritten —
// see the note in `AcmeSecurityReport.vue`.) This example surfaces an "Acme compliance" note
// for a task; a real deployment would show live data from its own store.
import { computed } from 'vue'
import { usePanelSubject } from '@modular-vue/core'
import { PanelsInspectorSection as InspectorSection } from '#components'

/** The subject the inspector injects. Typed structurally so this example needs no deep
 *  import of the layer's `Block` type (that reachable public type is slice G's job). */
interface InspectedBlock {
  id: string
  title: string
  level: 'frame' | 'module' | 'task'
}

const block = usePanelSubject<InspectedBlock>()
const { t } = useI18n()

// The demo "compliance status" is derived deterministically from the block id so the panel
// renders stable, assertable content without a backend. A real consumer reads its own store.
const compliant = computed(() => (block.value?.id.length ?? 0) % 2 === 0)
</script>

<template>
  <InspectorSection
    :title="t('acme.incidentPanel.title')"
    icon="i-lucide-shield-alert"
    :hint="t('acme.incidentPanel.hint')"
    default-open
  >
    <div class="flex flex-col gap-2 pt-1" data-testid="acme-incident-panel">
      <div class="flex items-center gap-2">
        <span
          class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
          :class="
            compliant ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
          "
          data-testid="acme-incident-status"
        >
          {{ compliant ? t('acme.incidentPanel.compliant') : t('acme.incidentPanel.actionNeeded') }}
        </span>
        <span class="truncate text-[12px] text-slate-400">{{ block?.title }}</span>
      </div>
      <p class="text-[11px] leading-relaxed text-slate-500">
        {{ t('acme.incidentPanel.body') }}
      </p>
    </div>
  </InspectorSection>
</template>
