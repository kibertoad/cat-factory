<script setup lang="ts">
// A WORKED EXAMPLE of a CONSUMER-shipped top-level OVERLAY (extension slice D — the
// frontend-extension-mechanism initiative). It is opened from the deployment's own sidebar /
// command-palette entry (`~/modular/acme-security.ts`'s `nav` `run` closure), which calls the
// auto-imported `useAppOverlays().open('acme:security-dashboard-overlay')`. Before slice D that
// `run` closure could only fire a toast — there was no host surface a consumer overlay could
// mount into. Now the layer's single `<AppOverlayHost>` resolves the `appOverlays` slot and
// mounts THIS component, with ZERO host edits.
//
// Like the example result window, it DOGFOODS the layer's shared building blocks: the modal
// chrome + behaviour (focus-trap, scroll-lock, shared-stack Escape) come from the shared
// `ResultWindowShell` (referenced through the `#components` virtual module, never a deep layer
// path). The host hands the overlay its optional `subject` as a prop and listens for `close`;
// this dashboard has no subject, and forwards the shell's close straight through. All copy is
// translated through the deployment's own i18n catalog (`acme.*`, deep-merged into the layer's).
import { PanelsResultWindowShell as ResultWindowShell } from '#components'

// The host passes the (optional) subject from `openOverlay(id, subject?)`. This dashboard is
// subject-less, but a real consumer overlay would render against it (e.g. a selected block id).
defineProps<{ subject?: unknown }>()
// The host wires `@close` to `ui.closeOverlay()`; the shell's X / backdrop / Escape all route
// here, so the consumer never touches the layer store to close itself.
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
</script>

<template>
  <ResultWindowShell
    :open="true"
    icon="i-lucide-shield-check"
    icon-class="bg-rose-500/15 text-rose-300"
    :title="t('acme.securityDashboard.title')"
    :subtitle="t('acme.securityDashboard.subtitle')"
    variant="centered"
    testid="acme-security-dashboard-window"
    @close="emit('close')"
  >
    <div class="px-5 py-6" data-testid="acme-security-dashboard-body">
      <p class="text-[13px] leading-relaxed text-slate-300">
        {{ t('acme.securityDashboard.body') }}
      </p>
      <ul class="mt-4 flex flex-col gap-2">
        <li
          v-for="item in [1, 2, 3]"
          :key="item"
          class="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-[12px] text-slate-400"
        >
          <UIcon name="i-lucide-shield-check" class="h-4 w-4 shrink-0 text-rose-300/70" />
          {{ t('acme.securityDashboard.placeholderRow', { n: item }) }}
        </li>
      </ul>
    </div>
  </ResultWindowShell>
</template>
