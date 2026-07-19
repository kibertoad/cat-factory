<script setup lang="ts">
// The environment-setup journey's PREFLIGHT step (slice 3 of the modular-vue
// adoption). Runs the working recipe's declared host preflight checks (degrades
// on a non-local facade) and lets the operator advance to save. `next` is always
// allowed — preflights are advisory, not a hard gate.
import { computed } from 'vue'
import JourneyStepNav from '~/components/environments/steps/JourneyStepNav.vue'
import { useEnvironmentWizardTarget } from '~/modular/journeys/environmentSetup.frame'

const props = defineProps<{
  input: { frameId: string | null }
  exit: (name: 'advance') => void
  goBack?: () => void
}>()

const store = useEnvironmentWizardStore()
const preflights = usePreflightsStore()
const { t } = useI18n()

// Keep the data store pointed at THIS step's frame — a resume that lands here
// (or a prior open of a different frame) must not leave preflight reading another
// frame's recipe. Idempotent per frame; see the composable.
useEnvironmentWizardTarget(() => props.input.frameId)

// The host-probe runtime isn't wired (a non-local facade 503'd) — the checklist degrades to a note.
const preflightsUnavailable = computed(() => preflights.available === false)

const PREFLIGHT_COLOR: Record<'pass' | 'warn' | 'fail', 'success' | 'warning' | 'error'> = {
  pass: 'success',
  warn: 'warning',
  fail: 'error',
}
</script>

<template>
  <section class="space-y-3" data-testid="env-setup-step-preflight">
    <div class="flex items-center justify-between gap-2">
      <p class="text-sm text-slate-400">{{ t('environmentWizard.preflight.intro') }}</p>
      <UButton
        size="xs"
        variant="soft"
        color="primary"
        icon="i-lucide-list-checks"
        :loading="store.preflightRunning"
        data-testid="env-setup-preflight-run"
        @click="store.runPreflight()"
      >
        {{ t('environmentWizard.preflight.run') }}
      </UButton>
    </div>

    <p
      v-if="!store.recipe.prerequisites?.length"
      class="text-[12px] text-slate-500"
      data-testid="env-setup-preflight-none"
    >
      {{ t('environmentWizard.preflight.none') }}
    </p>
    <p
      v-else-if="preflightsUnavailable"
      class="text-[12px] text-amber-300/80"
      data-testid="env-setup-preflight-unavailable"
    >
      {{ t('environmentWizard.preflight.unavailable') }}
    </p>
    <p
      v-if="store.preflightError"
      class="text-[12px] text-rose-300/80"
      data-testid="env-setup-preflight-error"
    >
      {{ store.preflightError }}
    </p>

    <ul
      v-if="store.preflightResults?.length"
      class="space-y-2"
      data-testid="env-setup-preflight-results"
    >
      <li
        v-for="r in store.preflightResults"
        :key="r.title"
        class="rounded border border-slate-800 bg-slate-900/40 p-2"
      >
        <div class="flex items-center gap-2">
          <UBadge :color="PREFLIGHT_COLOR[r.status]" variant="subtle" size="sm">
            {{ r.status }}
          </UBadge>
          <span class="text-[12px] text-slate-200">{{ r.title }}</span>
          <span v-if="!r.required" class="ms-auto text-[10px] text-slate-500">
            {{ t('environmentWizard.preflight.optional') }}
          </span>
        </div>
        <p v-if="r.detail" class="mt-1 text-[11px] text-slate-400">{{ r.detail }}</p>
        <pre
          v-if="r.status !== 'pass' && r.remediation"
          class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-amber-900/40 bg-amber-950/20 p-1.5 text-[11px] text-amber-200/90"
          >{{ r.remediation }}</pre
        >
      </li>
    </ul>

    <JourneyStepNav :go-back="goBack">
      <template #primary>
        <UButton
          color="primary"
          trailing-icon="i-lucide-arrow-right"
          data-testid="env-setup-next"
          @click="exit('advance')"
        >
          {{ t('common.next') }}
        </UButton>
      </template>
    </JourneyStepNav>
  </section>
</template>
