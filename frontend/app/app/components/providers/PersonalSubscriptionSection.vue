<script setup lang="ts">
// Personal (individual-usage) subscriptions: Claude, GLM (Z.ai Coding Plan) and ChatGPT
// (Codex) are each licensed for INDIVIDUAL use only, so they are connected per-user here
// rather than pooled on the workspace. Each token is double-encrypted server-side under a
// personal PASSWORD (never stored); that password is what you'll enter when you start/retry
// such a run (cached locally so it's usually transparent). Recurring schedules can't use them.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SubscriptionVendor } from '~/types/domain'
import SecretInput from '~/components/common/SecretInput.vue'

const personal = usePersonalSubscriptionsStore()
const auth = useAuthStore()
const workspace = useWorkspaceStore()
const models = useModelsStore()
const toast = useToast()
const { t, d } = useI18n()
const { confirm } = useConfirm()

// Personal subscriptions are stored per-user, so they need a signed-in user. When there
// isn't one (a deployment running without sign-in), block the form so the user doesn't
// enter a token + password that can't be saved.
const needsSignIn = computed(() => !auth.user)

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

// A transient "credentials stored" confirmation shown inline right after a successful save.
// Emptying the form on success recomputes `disabledReason` back to "enter a token", so without
// this the user is greeted by a red validation error immediately after they succeeded — which
// reads as a failure. While this notice is set we suppress `disabledReason` and show it instead,
// then clear it after a few seconds (or the moment the user starts entering a new credential).
const savedNotice = ref<string | null>(null)
let savedTimer: ReturnType<typeof setTimeout> | undefined

function clearSavedNotice() {
  savedNotice.value = null
  if (savedTimer) {
    clearTimeout(savedTimer)
    savedTimer = undefined
  }
}

// Once the user touches the form again the success notice is stale — drop it so `disabledReason`
// guides the next entry as usual. Guard on non-empty input so the programmatic clear performed by
// a successful `connect()` (which resets the fields to empty) doesn't immediately wipe the notice
// we just set; switching vendor always clears it.
watch([token, password], ([tok, pwd]) => {
  if (savedNotice.value && (tok.trim() || pwd)) clearSavedNotice()
})
watch(vendor, () => clearSavedNotice())

onMounted(() => void personal.load())
onBeforeUnmount(() => clearSavedNotice())

const selectedMeta = computed(() => vendorMeta(vendor.value) ?? PERSONAL_VENDORS.value[0]!)
const existing = computed(() => personal.subscriptions.find((s) => s.vendor === vendor.value))

/**
 * Why the Connect button is disabled, or null when it's actionable. This is the single source
 * of truth: the button's `:disabled` is bound to `disabledReason !== null`, and the same value
 * renders in red next to it, so the button state and the shown reason can never disagree.
 */
const disabledReason = computed(() => {
  if (needsSignIn.value) return t('personalSubscriptions.disabledReason.signIn')
  if (!token.value.trim()) return t('personalSubscriptions.disabledReason.token')
  if (password.value.length < 6) return t('personalSubscriptions.disabledReason.password')
  return null
})

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
  const vendorName = selectedMeta.value.label
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
    // Confirm success inline (and transiently) so emptying the form doesn't surface the
    // `disabledReason` validation text as if the save had failed. It clears after a few
    // seconds, or as soon as the user starts entering another credential.
    savedNotice.value = t('personalSubscriptions.saved', { vendor: vendorName })
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(clearSavedNotice, 5000)
    // A connected subscription makes its vendor's models usable, so refresh the catalog:
    // this clears the "No AI model configured" banner and, if the default preset still
    // points at models this subscription doesn't cover, reactively surfaces the
    // preset-mismatch prompt (with its "pick a different preset" link).
    if (workspace.workspaceId) await models.refresh(workspace.workspaceId)
    toast.add({
      title: t('personalSubscriptions.toast.connected', { vendor: vendorName }),
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
  const ok = await confirm({
    title: t('personalSubscriptions.confirmDisconnect.title'),
    description: t('personalSubscriptions.confirmDisconnect.body', { vendor: vendorLabel(v) }),
    variant: 'destructive',
    confirmLabel: t('common.disconnect'),
    icon: 'i-lucide-unplug',
  })
  if (!ok) return
  try {
    await personal.remove(v)
    // Removing the subscription may drop the workspace's last usable model — refresh so the
    // AI-readiness banners re-evaluate (mirrors the API-key flow).
    if (workspace.workspaceId) await models.refresh(workspace.workspaceId)
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

    <ProvidersSignInRequiredNotice
      v-if="needsSignIn"
      :message="t('auth.signInRequired.personalSubscriptions')"
    />

    <!-- connected subscriptions -->
    <div
      v-for="sub in personal.subscriptions"
      :key="sub.vendor"
      class="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm"
    >
      <div>
        <span class="font-medium text-slate-200">{{ sub.label }}</span>
        <span class="ms-2 text-xs text-slate-500">{{ vendorLabel(sub.vendor) }}</span>
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
        :disabled="needsSignIn"
        class="w-64"
      />
    </UFormField>

    <!-- connect / replace form -->
    <ol
      class="list-decimal space-y-1.5 rounded-lg border border-slate-700 bg-slate-900/60 p-4 ps-8 text-sm text-slate-300"
    >
      <li v-for="(step, i) in selectedMeta.steps" :key="i">{{ step }}</li>
    </ol>

    <div class="space-y-2">
      <UFormField :label="t('personalSubscriptions.labelField')">
        <UInput
          v-model="label"
          :disabled="needsSignIn"
          :placeholder="t('personalSubscriptions.labelPlaceholder', { vendor: selectedMeta.label })"
        />
      </UFormField>
      <UFormField :label="selectedMeta.tokenLabel">
        <SecretInput
          v-model="token"
          :disabled="needsSignIn"
          :placeholder="selectedMeta.tokenPlaceholder"
          class="w-full font-mono"
        />
      </UFormField>
      <div class="flex flex-wrap gap-3">
        <UFormField :label="t('personalSubscriptions.passwordField')" class="flex-1">
          <SecretInput
            v-model="password"
            :disabled="needsSignIn"
            :placeholder="t('personalSubscriptions.passwordPlaceholder')"
          />
        </UFormField>
        <UFormField :label="t('personalSubscriptions.renewsField')">
          <UInput v-model="expiresOn" type="date" :disabled="needsSignIn" />
        </UFormField>
      </div>
      <div class="flex items-center justify-end gap-3">
        <p v-if="savedNotice" class="flex items-center gap-1.5 text-sm text-emerald-400">
          <UIcon name="i-lucide-check" class="size-4" />
          {{ savedNotice }}
        </p>
        <p v-else-if="disabledReason" class="text-sm text-rose-400">{{ disabledReason }}</p>
        <UButton
          :loading="busy"
          :disabled="disabledReason !== null"
          icon="i-lucide-shield-check"
          @click="connect()"
        >
          {{ existing ? t('personalSubscriptions.replace') : t('personalSubscriptions.connect') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
