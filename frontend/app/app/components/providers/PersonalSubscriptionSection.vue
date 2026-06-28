<script setup lang="ts">
// Personal (individual-usage) subscriptions: Claude, GLM (Z.ai Coding Plan) and ChatGPT
// (Codex) are each licensed for INDIVIDUAL use only, so they are connected per-user here
// rather than pooled on the workspace. Each token is double-encrypted server-side under a
// personal PASSWORD (never stored); that password is what you'll enter when you start/retry
// such a run (cached locally so it's usually transparent). Recurring schedules can't use them.
import { computed, onMounted, ref } from 'vue'
import type { SubscriptionVendor } from '~/types/domain'

const personal = usePersonalSubscriptionsStore()
const toast = useToast()
const { t, d } = useI18n()

/**
 * Per-vendor metadata driving the connect form + connected-row labels. Reactive to the
 * locale (rebuilds on switch). The token placeholders for `claude`/`codex` are literal
 * format examples (and the Codex one contains `{ }`, which are vue-i18n interpolation
 * metacharacters), so they stay inline rather than in the message catalog; only the GLM
 * placeholder is prose and lives in i18n.
 */
const PERSONAL_VENDORS = computed<
  {
    value: SubscriptionVendor
    label: string
    tokenLabel: string
    tokenPlaceholder: string
    steps: string[]
  }[]
>(() => [
  {
    value: 'claude',
    label: t('personalSubscriptions.vendors.claude.label'),
    tokenLabel: t('personalSubscriptions.vendors.claude.tokenLabel'),
    tokenPlaceholder: 'sk-ant-oat01-…',
    steps: [
      t('personalSubscriptions.vendors.claude.step1'),
      t('personalSubscriptions.vendors.claude.step2'),
      t('personalSubscriptions.vendors.claude.step3'),
    ],
  },
  {
    value: 'glm',
    label: t('personalSubscriptions.vendors.glm.label'),
    tokenLabel: t('personalSubscriptions.vendors.glm.tokenLabel'),
    tokenPlaceholder: t('personalSubscriptions.vendors.glm.tokenPlaceholder'),
    steps: [
      t('personalSubscriptions.vendors.glm.step1'),
      t('personalSubscriptions.vendors.glm.step2'),
      t('personalSubscriptions.vendors.glm.step3'),
    ],
  },
  {
    value: 'codex',
    label: t('personalSubscriptions.vendors.codex.label'),
    tokenLabel: t('personalSubscriptions.vendors.codex.tokenLabel'),
    tokenPlaceholder: '{ "auth_mode": "chatgpt", "tokens": { … } }',
    steps: [
      t('personalSubscriptions.vendors.codex.step1'),
      t('personalSubscriptions.vendors.codex.step2'),
      t('personalSubscriptions.vendors.codex.step3'),
    ],
  },
])

function vendorMeta(v: SubscriptionVendor) {
  return PERSONAL_VENDORS.value.find((m) => m.value === v)
}

function vendorLabel(v: SubscriptionVendor): string {
  return vendorMeta(v)?.label ?? v
}

const vendor = ref<SubscriptionVendor>('claude')
const label = ref('')
const token = ref('')
const password = ref('')
const expiresOn = ref('') // yyyy-mm-dd (optional)
const busy = ref(false)

onMounted(() => void personal.load())

const selectedMeta = computed(() => vendorMeta(vendor.value) ?? PERSONAL_VENDORS.value[0]!)
const existing = computed(() => personal.subscriptions.find((s) => s.vendor === vendor.value))

/** Renewal nudges for any connected subscription that's near or past expiry. */
const renewals = computed(() =>
  personal.subscriptions
    .filter((s) => s.expiresAt !== null && (s.expired || s.renewSoon))
    .map((s) => {
      const vendorName = vendorLabel(s.vendor)
      if (s.expired) return t('personalSubscriptions.renewal.expired', { vendor: vendorName })
      const days = s.expiresInDays ?? 0
      return t('personalSubscriptions.renewal.soon', { vendor: vendorName, count: days }, days)
    }),
)

async function connect() {
  if (!token.value.trim() || password.value.length < 6) return
  busy.value = true
  try {
    await personal.store({
      vendor: vendor.value,
      label:
        label.value.trim() ||
        t('personalSubscriptions.defaultLabel', { vendor: selectedMeta.value.label }),
      token: token.value.trim(),
      password: password.value,
      expiresAt: expiresOn.value ? new Date(`${expiresOn.value}T00:00:00Z`).getTime() : null,
    })
    token.value = ''
    password.value = ''
    label.value = ''
    expiresOn.value = ''
    toast.add({
      title: t('personalSubscriptions.toast.connected', { vendor: selectedMeta.value.label }),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: t('personalSubscriptions.toast.connectFailed'),
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    busy.value = false
  }
}

async function disconnect(v: SubscriptionVendor) {
  try {
    await personal.remove(v)
    toast.add({ title: t('personalSubscriptions.toast.disconnected'), icon: 'i-lucide-check' })
  } catch (e) {
    toast.add({
      title: t('personalSubscriptions.toast.disconnectFailed'),
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  }
}
</script>

<template>
  <div class="space-y-3">
    <div>
      <h4 class="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {{ t('personalSubscriptions.heading') }}
      </h4>
      <p class="mt-1 text-sm text-slate-400">{{ t('personalSubscriptions.intro') }}</p>
    </div>

    <!-- connected subscriptions -->
    <div
      v-for="sub in personal.subscriptions"
      :key="sub.vendor"
      class="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm"
    >
      <div>
        <span class="font-medium text-slate-200">{{ sub.label }}</span>
        <span class="ml-2 text-xs text-slate-500">{{ vendorLabel(sub.vendor) }}</span>
        <div class="text-[11px] text-slate-500">
          <template v-if="sub.expiresAt">
            {{ t('personalSubscriptions.expires', { date: d(new Date(sub.expiresAt), 'short') }) }}
          </template>
          <template v-else>{{ t('personalSubscriptions.noExpiry') }}</template>
        </div>
      </div>
      <UButton
        icon="i-lucide-trash-2"
        color="error"
        variant="ghost"
        size="xs"
        @click="disconnect(sub.vendor)"
      />
    </div>

    <p v-for="(line, i) in renewals" :key="i" class="text-sm text-amber-400/90">{{ line }}</p>

    <!-- vendor picker -->
    <UFormField :label="t('personalSubscriptions.vendorField')">
      <USelect
        v-model="vendor"
        :items="PERSONAL_VENDORS.map((m) => ({ label: m.label, value: m.value }))"
        class="w-64"
      />
    </UFormField>

    <!-- connect / replace form -->
    <ol
      class="list-decimal space-y-1.5 rounded-lg border border-slate-700 bg-slate-900/60 p-4 pl-8 text-sm text-slate-300"
    >
      <li v-for="(step, i) in selectedMeta.steps" :key="i">{{ step }}</li>
    </ol>

    <div class="space-y-2">
      <UFormField :label="t('personalSubscriptions.labelField')">
        <UInput
          v-model="label"
          :placeholder="t('personalSubscriptions.labelPlaceholder', { vendor: selectedMeta.label })"
        />
      </UFormField>
      <UFormField :label="selectedMeta.tokenLabel">
        <UTextarea
          v-model="token"
          :rows="2"
          :placeholder="selectedMeta.tokenPlaceholder"
          class="font-mono"
        />
      </UFormField>
      <div class="flex flex-wrap gap-3">
        <UFormField :label="t('personalSubscriptions.passwordField')" class="flex-1">
          <UInput
            v-model="password"
            type="password"
            :placeholder="t('personalSubscriptions.passwordPlaceholder')"
          />
        </UFormField>
        <UFormField :label="t('personalSubscriptions.renewsField')">
          <UInput v-model="expiresOn" type="date" />
        </UFormField>
      </div>
      <div class="flex justify-end">
        <UButton
          :loading="busy"
          :disabled="!token.trim() || password.length < 6"
          icon="i-lucide-shield-check"
          @click="connect()"
        >
          {{ existing ? t('personalSubscriptions.replace') : t('personalSubscriptions.connect') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
