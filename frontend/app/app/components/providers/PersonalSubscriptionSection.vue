<script setup lang="ts">
// Personal (individual-usage) subscription: Anthropic's consumer Claude subscription is
// licensed for INDIVIDUAL use only, so it is connected per-user here rather than pooled
// on the workspace. The token is double-encrypted server-side under a personal PASSWORD
// (never stored); that password is what you'll enter when you start/retry a Claude run
// (cached locally so it's usually transparent). Recurring schedules can't use it.
import { computed, onMounted, ref } from 'vue'

const personal = usePersonalSubscriptionsStore()
const toast = useToast()

const label = ref('')
const token = ref('')
const password = ref('')
const expiresOn = ref('') // yyyy-mm-dd (optional)
const busy = ref(false)

onMounted(() => void personal.load())

const claude = computed(() => personal.subscriptions.find((s) => s.vendor === 'claude'))

function renewalText(): string | null {
  const s = claude.value
  if (!s || s.expiresAt === null) return null
  if (s.expired) return 'Your Claude subscription has expired — renew it and reconnect to keep running Claude models.'
  if (s.renewSoon)
    return `Your Claude subscription renews in ${s.expiresInDays} day${s.expiresInDays === 1 ? '' : 's'} — update it here once renewed.`
  return null
}

async function connect() {
  if (!token.value.trim() || password.value.length < 8) return
  busy.value = true
  try {
    await personal.store({
      vendor: 'claude',
      label: label.value.trim() || 'My Claude subscription',
      token: token.value.trim(),
      password: password.value,
      expiresAt: expiresOn.value ? new Date(`${expiresOn.value}T00:00:00Z`).getTime() : null,
    })
    token.value = ''
    password.value = ''
    label.value = ''
    expiresOn.value = ''
    toast.add({ title: 'Claude subscription connected', icon: 'i-lucide-check', color: 'success' })
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

async function disconnect() {
  try {
    await personal.remove('claude')
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
        Personal subscription (Claude — individual use only)
      </h4>
      <p class="mt-1 text-sm text-slate-400">
        Your Claude (Pro/Max) subscription is for individual use, so it’s stored
        <strong>just for you</strong> and only your runs use it. The token is encrypted under a
        personal password (never stored) that you enter when you start a Claude run — it’s cached in
        this browser for a while so it stays out of your way. Claude models can’t be used on
        recurring schedules.
      </p>
    </div>

    <!-- connected status -->
    <div
      v-if="claude"
      class="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm"
    >
      <div>
        <span class="font-medium text-slate-200">{{ claude.label }}</span>
        <span class="ml-2 text-xs text-slate-500">Claude (Pro/Max)</span>
        <div class="text-[11px] text-slate-500">
          <template v-if="claude.expiresAt">
            Expires {{ new Date(claude.expiresAt).toLocaleDateString() }}
          </template>
          <template v-else>No expiry set</template>
        </div>
      </div>
      <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="xs" @click="disconnect()" />
    </div>

    <p v-if="renewalText()" class="text-sm text-amber-400/90">{{ renewalText() }}</p>

    <!-- connect / replace form -->
    <ol
      class="list-decimal space-y-1.5 rounded-lg border border-slate-700 bg-slate-900/60 p-4 pl-8 text-sm text-slate-300"
    >
      <li>
        Install Claude Code and sign in with your Claude Pro/Max account: run <code>claude</code>
        once and complete the browser login.
      </li>
      <li>Generate a long-lived token: run <code>claude setup-token</code> and copy it.</li>
      <li>Paste it below and choose a personal password to protect it.</li>
    </ol>

    <div class="space-y-2">
      <UFormField label="Label (optional)">
        <UInput v-model="label" placeholder="e.g. my Claude Max" />
      </UFormField>
      <UFormField label="Claude token">
        <UTextarea v-model="token" :rows="2" placeholder="sk-ant-oat01-…" class="font-mono" />
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
          {{ claude ? 'Replace' : 'Connect' }}
        </UButton>
      </div>
    </div>
  </div>
</template>
