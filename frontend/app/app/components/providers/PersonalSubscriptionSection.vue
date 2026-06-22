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

/** Per-vendor metadata driving the connect form + connected-row labels. */
const PERSONAL_VENDORS: {
  value: SubscriptionVendor
  label: string
  tokenLabel: string
  tokenPlaceholder: string
  steps: string[]
}[] = [
  {
    value: 'claude',
    label: 'Claude (Pro/Max)',
    tokenLabel: 'Claude token',
    tokenPlaceholder: 'sk-ant-oat01-…',
    steps: [
      'Install Claude Code and sign in with your Claude Pro/Max account: run `claude` once and complete the browser login.',
      'Generate a long-lived token: run `claude setup-token` and copy it.',
      'Paste it below and choose a personal password to protect it.',
    ],
  },
  {
    value: 'glm',
    label: 'GLM (Z.ai Coding Plan)',
    tokenLabel: 'Z.ai API key',
    tokenPlaceholder: 'your GLM Coding Plan API key',
    steps: [
      'Open your Z.ai GLM Coding Plan dashboard and create an API key for the Anthropic-compatible endpoint.',
      'The GLM Coding Plan is licensed to you as an individual, so it is stored per-user here (not pooled).',
      'Paste the key below and choose a personal password to protect it.',
    ],
  },
  {
    value: 'codex',
    label: 'ChatGPT (Codex)',
    tokenLabel: 'ChatGPT auth.json',
    tokenPlaceholder: '{ "auth_mode": "chatgpt", "tokens": { … } }',
    steps: [
      'Install the Codex CLI and sign in with your ChatGPT account: run `codex login` and complete the browser flow.',
      'Open the credentials file Codex wrote at ~/.codex/auth.json (on Windows %USERPROFILE%\\.codex\\auth.json).',
      'Copy the entire contents of auth.json, paste it below, and choose a personal password to protect it.',
    ],
  },
]

function vendorMeta(v: SubscriptionVendor) {
  return PERSONAL_VENDORS.find((m) => m.value === v)
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

const selectedMeta = computed(() => vendorMeta(vendor.value) ?? PERSONAL_VENDORS[0]!)
const existing = computed(() => personal.subscriptions.find((s) => s.vendor === vendor.value))

/** Renewal nudges for any connected subscription that's near or past expiry. */
const renewals = computed(() =>
  personal.subscriptions
    .filter((s) => s.expiresAt !== null && (s.expired || s.renewSoon))
    .map((s) => {
      const name = vendorLabel(s.vendor)
      if (s.expired)
        return `Your ${name} subscription has expired — renew it and reconnect to keep running its models.`
      return `Your ${name} subscription renews in ${s.expiresInDays} day${s.expiresInDays === 1 ? '' : 's'} — update it here once renewed.`
    }),
)

async function connect() {
  if (!token.value.trim() || password.value.length < 8) return
  busy.value = true
  try {
    await personal.store({
      vendor: vendor.value,
      label: label.value.trim() || `My ${selectedMeta.value.label} subscription`,
      token: token.value.trim(),
      password: password.value,
      expiresAt: expiresOn.value ? new Date(`${expiresOn.value}T00:00:00Z`).getTime() : null,
    })
    token.value = ''
    password.value = ''
    label.value = ''
    expiresOn.value = ''
    toast.add({
      title: `${selectedMeta.value.label} subscription connected`,
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: 'Could not connect subscription',
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
    toast.add({ title: 'Disconnected', icon: 'i-lucide-check' })
  } catch (e) {
    toast.add({
      title: 'Could not disconnect',
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
        Personal subscriptions (individual use only)
      </h4>
      <p class="mt-1 text-sm text-slate-400">
        Claude (Pro/Max), GLM (Z.ai Coding Plan) and ChatGPT (Codex) are each licensed to you as an
        individual, so they’re stored <strong>just for you</strong> and only your runs use them.
        Each token is encrypted under a personal password (never stored) that you enter when you
        start such a run — it’s cached in this browser for a while so it stays out of your way. The
        password is a low-friction convenience and a transparency signal that the system won’t
        silently share your credential — it is <strong>not</strong> a wall against a system-key
        holder. These models can’t be used on recurring schedules.
      </p>
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
            Expires {{ new Date(sub.expiresAt).toLocaleDateString() }}
          </template>
          <template v-else>No expiry set</template>
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
    <UFormField label="Subscription">
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
      <UFormField label="Label (optional)">
        <UInput v-model="label" :placeholder="`e.g. my ${selectedMeta.label}`" />
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
        <UFormField label="Personal password (min 8 chars)" class="flex-1">
          <UInput v-model="password" type="password" placeholder="protects your token" />
        </UFormField>
        <UFormField label="Subscription renews on (optional)">
          <UInput v-model="expiresOn" type="date" />
        </UFormField>
      </div>
      <div class="flex justify-end">
        <UButton
          :loading="busy"
          :disabled="!token.trim() || password.length < 8"
          icon="i-lucide-shield-check"
          @click="connect()"
        >
          {{ existing ? 'Replace' : 'Connect' }}
        </UButton>
      </div>
    </div>
  </div>
</template>
