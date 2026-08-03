<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type {
  PlatformAlertSettings,
  PlatformAlertThresholdOverrides,
  PlatformAlertWindow,
} from '~/types/execution'

// Per-account tuning for the platform-health alert sweep (admin only): the ceilings the
// deployment's aggregate run health is checked against, and the window they are evaluated over.
// The deployment's env vars set the DEFAULTS; anything left blank here inherits them, so this
// panel is an override sheet rather than a settings form.
//
// That distinction drives the whole component. An empty field means "inherit", NOT zero, and a
// zero is a live setting in this vocabulary (a `minStalledPriorRuns` of 0 says "page even on an
// idle window"), so the editor keeps blank and 0 apart end to end and only sends the fields the
// admin actually filled in.
const props = defineProps<{ accountId: string }>()

const store = useAccountSettingsStore()
const toast = useToast()
const { t } = useI18n()

const WINDOWS = ['1h', '24h', '7d'] as const satisfies readonly PlatformAlertWindow[]

// Exhaustive enum→key map (the tier-2 dynamic-key guard): adding a window without a label
// fails the typecheck here rather than rendering a raw code.
const windowLabels = computed<Record<PlatformAlertWindow, string>>(() => ({
  '1h': t('settings.platformAlerts.window.oneHour'),
  '24h': t('settings.platformAlerts.window.oneDay'),
  '7d': t('settings.platformAlerts.window.sevenDays'),
}))
const windowItems = computed(() =>
  [
    { label: t('settings.platformAlerts.window.inherit'), value: '' },
    ...WINDOWS.map((w) => ({ label: windowLabels.value[w], value: w })),
  ].map((i) => i),
)

/**
 * The numeric ceilings, each rendered as one row: the contract key plus the input's step.
 * ONE table drives the form, the hydrate and the save, so adding a threshold to the contract
 * is a single entry rather than a form field plus a save branch free to disagree with it.
 */
const THRESHOLDS = [
  { field: 'minRuns', step: 1 },
  { field: 'maxFailureRate', step: 0.05 },
  { field: 'maxP99DurationMs', step: 1 },
  { field: 'maxBacklog', step: 1 },
  { field: 'stalledBuckets', step: 1 },
  { field: 'minStalledPriorRuns', step: 1 },
  { field: 'maxFailureKindShare', step: 0.05 },
  { field: 'maxSweepFailures', step: 1 },
] as const satisfies readonly { field: keyof PlatformAlertThresholdOverrides; step: number }[]

type ThresholdField = (typeof THRESHOLDS)[number]['field']

// Exhaustive label/hint maps, same drift guard as the windows above.
const thresholdLabels = computed<Record<ThresholdField, string>>(() => ({
  minRuns: t('settings.platformAlerts.thresholds.minRuns'),
  maxFailureRate: t('settings.platformAlerts.thresholds.maxFailureRate'),
  maxP99DurationMs: t('settings.platformAlerts.thresholds.maxP99DurationMs'),
  maxBacklog: t('settings.platformAlerts.thresholds.maxBacklog'),
  stalledBuckets: t('settings.platformAlerts.thresholds.stalledBuckets'),
  minStalledPriorRuns: t('settings.platformAlerts.thresholds.minStalledPriorRuns'),
  maxFailureKindShare: t('settings.platformAlerts.thresholds.maxFailureKindShare'),
  maxSweepFailures: t('settings.platformAlerts.thresholds.maxSweepFailures'),
}))
const thresholdHints = computed<Record<ThresholdField, string>>(() => ({
  minRuns: t('settings.platformAlerts.hints.minRuns'),
  maxFailureRate: t('settings.platformAlerts.hints.maxFailureRate'),
  maxP99DurationMs: t('settings.platformAlerts.hints.maxP99DurationMs'),
  maxBacklog: t('settings.platformAlerts.hints.maxBacklog'),
  stalledBuckets: t('settings.platformAlerts.hints.stalledBuckets'),
  minStalledPriorRuns: t('settings.platformAlerts.hints.minStalledPriorRuns'),
  maxFailureKindShare: t('settings.platformAlerts.hints.maxFailureKindShare'),
  maxSweepFailures: t('settings.platformAlerts.hints.maxSweepFailures'),
}))

// Editable state. Every value is a STRING so an empty field stays distinguishable from a typed
// `0`: binding a number input to a nullable number collapses those two the moment the field is
// cleared, and one of them is "leave the deployment default alone".
const muted = ref(false)
const alertWindow = ref<PlatformAlertWindow | ''>('')
const values = ref<Record<ThresholdField, string>>(blankValues())
const saving = ref(false)

function blankValues(): Record<ThresholdField, string> {
  return Object.fromEntries(THRESHOLDS.map((th) => [th.field, ''])) as Record<
    ThresholdField,
    string
  >
}

/** The p99 ceiling is stored in ms and edited in MINUTES, which is how operators think of it. */
function toDisplay(field: ThresholdField, stored: number | undefined): string {
  if (stored === undefined) return ''
  return field === 'maxP99DurationMs' ? String(stored / 60_000) : String(stored)
}
function fromDisplay(field: ThresholdField, raw: string): number | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return undefined
  return field === 'maxP99DurationMs' ? Math.round(n * 60_000) : n
}

function hydrate() {
  const stored = store.view?.config?.platformAlerts
  muted.value = stored?.enabled === false
  alertWindow.value = stored?.window ?? ''
  const next = blankValues()
  for (const th of THRESHOLDS) next[th.field] = toDisplay(th.field, stored?.thresholds?.[th.field])
  values.value = next
}

onMounted(async () => {
  // A sibling panel loads the same store on mount; only load when nothing is there yet.
  if (!store.view && store.available !== false) {
    try {
      await store.load(props.accountId)
    } catch {
      // The deployment-settings panel surfaces the load error; stay quiet here.
    }
  }
  hydrate()
})
watch(() => store.view, hydrate)

/** The overrides to persist: only the fields the admin actually filled in. */
function collectThresholds(): PlatformAlertThresholdOverrides {
  const out: PlatformAlertThresholdOverrides = {}
  for (const th of THRESHOLDS) {
    const parsed = fromDisplay(th.field, values.value[th.field])
    if (parsed !== undefined) out[th.field] = parsed
  }
  return out
}

async function save() {
  const thresholds = collectThresholds()
  // Each key is omitted rather than nulled when it carries no override: an absent key is what
  // the backend reads as "inherit the deployment default", and a stored null would be a value.
  const settings: PlatformAlertSettings = {
    ...(muted.value ? { enabled: false } : {}),
    ...(alertWindow.value ? { window: alertWindow.value } : {}),
    ...(Object.keys(thresholds).length > 0 ? { thresholds } : {}),
  }
  saving.value = true
  try {
    // `config` fully replaces the stored non-secret config, so carry the rest forward. An empty
    // override sheet stores an empty object, which is the same thing as inheriting everything.
    await store.save(props.accountId, {
      config: { ...store.view?.config, platformAlerts: settings },
    })
    toast.add({
      title: t('settings.platformAlerts.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: t('settings.platformAlerts.saveFailed'),
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}

function resetAll() {
  muted.value = false
  alertWindow.value = ''
  values.value = blankValues()
}

const hasOverrides = computed(
  () =>
    muted.value ||
    alertWindow.value !== '' ||
    THRESHOLDS.some((th) => values.value[th.field].trim() !== ''),
)
</script>

<template>
  <section
    v-if="store.available !== false"
    data-testid="account-platform-alerts"
    class="space-y-3 border-t border-slate-800 pt-6"
  >
    <div>
      <h4 class="text-sm font-semibold text-slate-200">
        {{ t('settings.platformAlerts.title') }}
      </h4>
      <p class="text-[11px] text-slate-400">{{ t('settings.platformAlerts.description') }}</p>
    </div>

    <!--
      The one-way switch. It is stated rather than presented as a symmetric toggle because it
      genuinely is one: the deployment's env var decides whether the sweep runs at all, and no
      stored row can start a timer that was never started.
    -->
    <div class="space-y-1">
      <UCheckbox
        v-model="muted"
        size="sm"
        :label="t('settings.platformAlerts.muteLabel')"
        data-testid="platform-alerts-mute"
      />
      <p class="ps-6 text-[11px] text-slate-400">{{ t('settings.platformAlerts.muteHint') }}</p>
    </div>

    <div class="space-y-1">
      <label class="text-[11px] font-medium text-slate-300">
        {{ t('settings.platformAlerts.windowLabel') }}
      </label>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <USelect
          v-model="alertWindow"
          :items="windowItems"
          value-key="value"
          size="sm"
          data-testid="platform-alerts-window"
        />
      </div>
      <p class="text-[11px] text-slate-400">{{ t('settings.platformAlerts.windowHint') }}</p>
    </div>

    <div class="space-y-2">
      <label class="text-[11px] font-medium text-slate-300">
        {{ t('settings.platformAlerts.thresholdsLabel') }}
      </label>
      <p class="text-[11px] text-slate-400">{{ t('settings.platformAlerts.inheritHint') }}</p>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div v-for="th in THRESHOLDS" :key="th.field" class="space-y-1">
          <label class="block text-[11px] text-slate-300" :for="`platform-alert-${th.field}`">
            {{ thresholdLabels[th.field] }}
          </label>
          <UInput
            :id="`platform-alert-${th.field}`"
            v-model="values[th.field]"
            type="number"
            :step="th.step"
            size="sm"
            :placeholder="t('settings.platformAlerts.inheritPlaceholder')"
            :data-testid="`platform-alert-${th.field}`"
          />
          <p class="text-[11px] leading-snug text-slate-500">{{ thresholdHints[th.field] }}</p>
        </div>
      </div>
    </div>

    <div class="flex gap-2">
      <UButton
        color="primary"
        size="xs"
        icon="i-lucide-save"
        :loading="saving"
        data-testid="account-platform-alerts-save"
        @click="save"
      >
        {{ t('common.save') }}
      </UButton>
      <UButton
        v-if="hasOverrides"
        color="neutral"
        variant="subtle"
        size="xs"
        icon="i-lucide-rotate-ccw"
        data-testid="account-platform-alerts-reset"
        @click="resetAll"
      >
        {{ t('settings.platformAlerts.reset') }}
      </UButton>
    </div>
  </section>
</template>
