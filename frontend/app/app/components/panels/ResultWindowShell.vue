<script setup lang="ts">
// Shared modal shell for the agent-run result windows (slice 5 of the modular-vue
// adoption — docs/initiatives/modular-vue-adoption.md; progress in
// docs/initiatives/modular-vue-slice5-progress.md).
//
// Every result window (the merger verdict, the tester report, the requirements-review
// loop, the gates, …) used to hand-roll the SAME modal chrome — `<Teleport>`, a
// backdrop, a bordered card, a header row with an icon/title/close — and, worse,
// re-implemented the modal *behaviour* inconsistently: only 2 of ~18 trapped focus, each
// registered its own global Escape listener, and every one hard-coded `z-50` with no
// stacking. This shell centralises the chrome AND delegates the behaviour to the upstream
// `useModalBehavior` (`@modular-vue/core`, the slice-5 overlay-host release): focus-trap
// + focus-return, body-scroll lock, and a shared overlay STACK so the top overlay closes
// first on Escape. A window becomes body-only markup wrapped in `<ResultWindowShell>`; it
// keeps its `useResultView` seam but passes `manageEscape: false` (the shell owns Escape).
//
// The pick-one SELECTION of which window is active stays exactly the slice-2
// `resolveComponentRegistry` in `StepResultViewHost.vue` — this shell only owns the
// per-window chrome + behaviour, so windows convert one at a time behind it.
import { computed } from 'vue'
import { useModalBehavior } from '@modular-vue/core'
import StepRestartControl from '~/components/panels/StepRestartControl.vue'

/** A pipeline step reference — passed by step-result windows to surface the shared
 *  "restart from here" control. `StepRestartControl` self-hides for an off-path open
 *  (null ids), so a block-keyed window simply omits this prop. */
type StepRef = { instanceId: string | null; stepIndex: number | null }

const props = withDefaults(
  defineProps<{
    /** Whether the window is open — drives the modal behaviour's activation. */
    open: boolean
    /** Header icon (a `UIcon` name) + its badge colour classes. */
    icon?: string
    iconClass?: string
    /** Header title (the accessible dialog name) + optional secondary line. */
    title: string
    subtitle?: string
    /** Card width bucket + backdrop layout (the two pre-slice-5 chrome variants). */
    width?: '3xl' | '4xl' | '5xl'
    variant?: 'stretch' | 'centered'
    /** Provide on step-result windows to show the shared restart control; omit on gates
     *  and block-keyed windows (no restart mid-gate / pre-run). */
    stepRef?: StepRef
    /** `data-testid` on the dialog root — pass a window's existing id to preserve e2e
     *  selectors; defaults to `result-window`. */
    testid?: string
  }>(),
  {
    icon: 'i-lucide-square',
    iconClass: 'bg-slate-500/15 text-slate-300',
    subtitle: undefined,
    width: '3xl',
    variant: 'stretch',
    stepRef: undefined,
    testid: undefined,
  },
)

const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

function requestClose() {
  emit('close')
}

// Managed modal behaviour (focus-trap + return, scroll lock, shared-stack Escape). The
// window unmounts on close, so deactivation + cleanup fire via `active` going false and
// unmount — no manual teardown here.
const { dialogRef } = useModalBehavior({
  active: () => props.open,
  onClose: requestClose,
})

const WIDTH: Record<'3xl' | '4xl' | '5xl', string> = {
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
}
const backdropClass = computed(() => [
  'fixed inset-0 z-50 flex max-h-[100dvh] justify-center bg-slate-950/70 backdrop-blur-sm',
  props.variant === 'centered' ? 'items-center p-4' : 'items-stretch',
])
const panelClass = computed(() => [
  'flex w-full flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl',
  WIDTH[props.width],
  props.variant === 'centered' ? 'max-h-[90dvh]' : 'm-4',
])
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      :class="backdropClass"
      data-testid="result-window-backdrop"
      @click.self="requestClose"
    >
      <div
        ref="dialogRef"
        tabindex="-1"
        :class="panelClass"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        :data-testid="testid ?? 'result-window'"
      >
        <header class="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <span
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
            :class="iconClass"
          >
            <UIcon :name="icon" class="h-4 w-4" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-sm font-semibold text-slate-100">{{ title }}</h2>
            <p v-if="subtitle" class="truncate text-[11px] text-slate-400">{{ subtitle }}</p>
          </div>
          <!-- Window-specific header content (status badges, counts). -->
          <slot name="header-extras" />
          <StepRestartControl
            v-if="stepRef"
            :instance-id="stepRef.instanceId"
            :step-index="stepRef.stepIndex"
            @restarted="requestClose"
          />
          <button
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            data-testid="result-window-close"
            :aria-label="t('common.close')"
            @click="requestClose"
          >
            <UIcon name="i-lucide-x" class="h-4 w-4" />
          </button>
        </header>
        <!-- The window body. -->
        <slot />
      </div>
    </div>
  </Teleport>
</template>
