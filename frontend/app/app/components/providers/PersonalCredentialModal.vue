<script setup lang="ts">
// Prompts for the personal password (or to connect a subscription) the moment a
// start/retry of an individual-usage-pinned run needs it — driven by the
// personalSubscriptions store's `pending` state, which is set when the server replies 428
// credential_required. On submit it transparently retries the gated action and caches the
// password. The copy follows the pending vendor (Claude / GLM / ChatGPT-Codex).
import { computed, ref, watch } from 'vue'
import type { SubscriptionVendor } from '~/types/domain'

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

const VENDOR_LABELS: Partial<Record<SubscriptionVendor, string>> = {
  claude: 'Claude',
  glm: 'GLM (Z.ai)',
  codex: 'ChatGPT (Codex)',
}

/** Display label for the pending vendor (falls back to the raw vendor string). */
const vendorLabel = computed(() => {
  const v = pending.value?.vendor
  if (!v) return 'subscription'
  return VENDOR_LABELS[v] ?? v
})

watch(open, (isOpen) => {
  if (isOpen) password.value = ''
})

const title = computed(() => {
  switch (pending.value?.reason) {
    case 'wrong_password':
      return 'Incorrect personal password'
    case 'no_subscription':
      return `Connect your ${vendorLabel.value} subscription`
    case 'subscription_expired':
      return `Your ${vendorLabel.value} subscription expired`
    default:
      return 'Enter your personal password'
  }
})

async function submit() {
  if (!pending.value || password.value.length < 8) return
  busy.value = true
  try {
    await pending.value.retry(password.value)
    toast.add({ title: 'Run started', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    // A fresh 428 (e.g. still-wrong password) re-arms `pending`, keeping the modal open.
    toast.add({
      title: 'Could not start the run',
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
            This task uses a {{ vendorLabel }} model, which runs on <strong>your own</strong>
            {{ vendorLabel }} subscription. Connect (or renew) it first, then start the run again.
          </p>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="open = false">Cancel</UButton>
            <UButton icon="i-lucide-shield-check" @click="goConnect()"
              >Connect subscription</UButton
            >
          </div>
        </template>

        <template v-else>
          <p class="text-sm text-slate-400">
            Enter the personal password that protects your {{ vendorLabel }} subscription. It
            unlocks your credential for this run only and is cached in this browser so you won’t be
            asked again for a while.
          </p>
          <UFormField label="Personal password">
            <UInput
              v-model="password"
              type="password"
              autofocus
              placeholder="your personal password"
              @keydown.enter="submit()"
            />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="open = false">Cancel</UButton>
            <UButton :loading="busy" :disabled="password.length < 8" @click="submit()">
              Unlock &amp; run
            </UButton>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
