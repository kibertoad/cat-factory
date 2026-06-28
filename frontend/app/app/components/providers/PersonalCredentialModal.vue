<script setup lang="ts">
// Prompts for the personal password (or to connect a subscription) the moment a
// start/retry of an individual-usage-pinned run needs it — driven by the
// personalSubscriptions store's `pending` state, which is set when the server replies 428
// credential_required. On submit it transparently retries the gated action and caches the
// password. The copy follows the pending vendor (Claude / GLM / ChatGPT-Codex).
import { computed, ref, watch } from 'vue'

const { t } = useI18n()
const personal = usePersonalSubscriptionsStore()
const ui = useUiStore()
const toast = useToast()

const password = ref('')
const busy = ref(false)

const pending = computed(() => personal.pending)
const open = computed({
  get: () => pending.value !== null,
  set: (v: boolean) => {
    if (!v) personal.dismissPending()
  },
})

// A missing/expired subscription can't be solved by a password — point the user at the
// connect form instead. A password_required/wrong_password prompt just needs the field.
const needsConnect = computed(
  () =>
    pending.value?.reason === 'no_subscription' || pending.value?.reason === 'subscription_expired',
)

/** Display label for the pending vendor (falls back to the raw vendor string). */
const vendorLabel = computed(() => {
  switch (pending.value?.vendor) {
    case 'claude':
      return t('providers.personalCredential.vendors.claude')
    case 'glm':
      return t('providers.personalCredential.vendors.glm')
    case 'codex':
      return t('providers.personalCredential.vendors.codex')
    default:
      return pending.value?.vendor ?? t('providers.personalCredential.fallbackVendor')
  }
})

watch(open, (isOpen) => {
  if (isOpen) password.value = ''
})

const title = computed(() => {
  switch (pending.value?.reason) {
    case 'wrong_password':
      return t('providers.personalCredential.titleWrongPassword')
    case 'no_subscription':
      return t('providers.personalCredential.titleNoSubscription', { vendor: vendorLabel.value })
    case 'subscription_expired':
      return t('providers.personalCredential.titleExpired', { vendor: vendorLabel.value })
    default:
      return t('providers.personalCredential.titleDefault')
  }
})

async function submit() {
  if (!pending.value || password.value.length < 6) return
  busy.value = true
  try {
    await pending.value.retry(password.value)
    toast.add({
      title: t('providers.personalCredential.toast.started'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    // A fresh 428 (e.g. still-wrong password) re-arms `pending`, keeping the modal open.
    toast.add({
      title: t('providers.personalCredential.toast.startFailed'),
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    busy.value = false
  }
}

function goConnect() {
  personal.dismissPending()
  ui.openVendorCredentials()
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :ui="{ content: 'max-w-md' }">
    <template #body>
      <div class="space-y-4">
        <template v-if="needsConnect">
          <p class="text-sm text-slate-400">
            {{ t('providers.personalCredential.connectBody', { vendor: vendorLabel }) }}
          </p>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="open = false">
              {{ t('providers.personalCredential.cancel') }}
            </UButton>
            <UButton icon="i-lucide-shield-check" @click="goConnect()">
              {{ t('providers.personalCredential.connectCta') }}
            </UButton>
          </div>
        </template>

        <template v-else>
          <p class="text-sm text-slate-400">
            {{ t('providers.personalCredential.passwordBody', { vendor: vendorLabel }) }}
          </p>
          <UFormField :label="t('providers.personalCredential.passwordField')">
            <UInput
              v-model="password"
              type="password"
              autofocus
              :placeholder="t('providers.personalCredential.passwordPlaceholder')"
              @keydown.enter="submit()"
            />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="open = false">
              {{ t('providers.personalCredential.cancel') }}
            </UButton>
            <UButton :loading="busy" :disabled="password.length < 6" @click="submit()">
              {{ t('providers.personalCredential.submit') }}
            </UButton>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
