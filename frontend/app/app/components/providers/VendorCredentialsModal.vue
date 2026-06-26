<script setup lang="ts">
// LLM Vendors: connect commercial coding-plan subscription credentials (a token pool) so
// agent steps can run on the Claude Code harness instead of an API key. Tokens are
// write-only and pooled, leased with usage-aware rotation. Connecting a vendor makes its
// models win in the picker and at dispatch ("subscriptions always win"). Only genuinely
// poolable (team/organization-licensed) vendors live here; individual-use subscriptions
// (Claude, GLM, ChatGPT/Codex) are connected per-user in the Personal subscriptions section.
import { computed, ref, watch } from 'vue'
import type { SubscriptionVendor } from '~/types/domain'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const ui = useUiStore()
const workspace = useWorkspaceStore()
const creds = useVendorCredentialsStore()
const toast = useToast()

const open = computed({
  get: () => ui.vendorCredentialsOpen,
  set: (v: boolean) => (v ? ui.openVendorCredentials() : ui.closeVendorCredentials()),
})
const back = useIntegrationBack(open)

// Horizontal tabs replace the old long vertical scroll: each credential kind is its own
// section (pooled subscriptions, direct vendor keys, proxy/gateway keys, personal subs).
const activeTab = ref('pool')
const tabs = [
  { value: 'pool', label: 'Workspace pool', icon: 'i-lucide-users', slot: 'pool' },
  { value: 'direct', label: 'Direct providers', icon: 'i-lucide-key-round', slot: 'direct' },
  { value: 'proxy', label: 'Proxies', icon: 'i-lucide-route', slot: 'proxy' },
  {
    value: 'personal',
    label: 'Personal subscriptions',
    icon: 'i-lucide-user',
    slot: 'personal',
  },
]

// Only commercial coding-plan vendors that permit team/organization use are poolable here.
// Claude, GLM and ChatGPT/Codex are licensed for individual use only, so they are connected
// per-user in the "Personal subscriptions" section below (PersonalSubscriptionSection).
const VENDORS: { value: SubscriptionVendor; label: string; harness: string }[] = [
  { value: 'kimi', label: 'Kimi — Moonshot coding plan', harness: 'Claude Code' },
  { value: 'deepseek', label: 'DeepSeek — coding plan', harness: 'Claude Code' },
]

const visibleVendors = computed(() => VENDORS)

const vendor = ref<SubscriptionVendor>('kimi')
const label = ref('')
const token = ref('')
const busy = ref(false)

watch(open, (isOpen) => {
  if (isOpen && workspace.workspaceId) void creds.load(workspace.workspaceId)
})

/** Step-by-step instructions for the selected vendor. */
const steps = computed<string[]>(() => {
  switch (vendor.value) {
    case 'kimi':
      return [
        'Open your Moonshot (Kimi) coding-plan console and create an API key for the Anthropic-compatible endpoint.',
        'Copy the API key. Agent steps will run via Claude Code against Moonshot’s Anthropic endpoint with full context.',
        'Paste the key below.',
      ]
    case 'deepseek':
      return [
        'Open your DeepSeek coding-plan console and create an API key for the Anthropic-compatible endpoint.',
        'Copy the API key. Agent steps will run via Claude Code against DeepSeek’s Anthropic endpoint with full context.',
        'Paste the key below.',
      ]
    default:
      return []
  }
})

const tokenPlaceholder = computed(() => 'your coding-plan API key')

async function add() {
  if (!token.value.trim()) return
  busy.value = true
  try {
    await creds.add({
      vendor: vendor.value,
      label: label.value.trim() || `${vendor.value} token`,
      token: token.value.trim(),
    })
    token.value = ''
    label.value = ''
    toast.add({ title: 'Token connected', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    toast.add({
      title: 'Could not connect token',
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    busy.value = false
  }
}

async function remove(id: string) {
  try {
    await creds.remove(id)
  } catch (e) {
    toast.add({
      title: 'Could not remove token',
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  }
}

function vendorLabel(v: SubscriptionVendor): string {
  return VENDORS.find((x) => x.value === v)?.label ?? v
}
</script>

<template>
  <UModal v-model:open="open" title="LLM Vendors" :ui="{ content: 'max-w-2xl' }">
    <template #title>
      <IntegrationBackTitle title="LLM Vendors" @back="back" />
    </template>
    <template #body>
      <UTabs
        v-model="activeTab"
        :items="tabs"
        variant="link"
        :ui="{ root: 'gap-4', list: 'overflow-x-auto' }"
      >
        <!-- Workspace pool (commercial coding-plan subscriptions) -->
        <template #pool>
          <div class="space-y-5">
            <p class="text-sm text-slate-400">
              Connect a <strong>commercial</strong> coding-plan subscription (Kimi, DeepSeek) that
              permits team/organization use to run agent steps on the Claude Code harness instead of
              an API key. Tokens are stored encrypted, pooled, and rotated by usage. Subscription
              models are flat-rate quota — they don’t draw on your spend budget. Individual-use
              subscriptions (Claude, GLM, ChatGPT/Codex) are connected per-user in the Personal
              subscriptions tab.
            </p>

            <!-- vendor picker -->
            <div class="flex flex-wrap items-end gap-3">
              <UFormField label="Vendor">
                <USelect
                  v-model="vendor"
                  :items="visibleVendors.map((v) => ({ label: v.label, value: v.value }))"
                  class="w-64"
                />
              </UFormField>
            </div>

            <!-- guided steps -->
            <ol
              class="list-decimal space-y-1.5 rounded-lg border border-slate-700 bg-slate-900/60 p-4 pl-8 text-sm text-slate-300"
            >
              <li v-for="(step, i) in steps" :key="i">{{ step }}</li>
            </ol>

            <!-- add form -->
            <div class="space-y-2">
              <UFormField label="Label (optional)">
                <UInput v-model="label" placeholder="e.g. work account" />
              </UFormField>
              <UFormField label="Token">
                <UTextarea
                  v-model="token"
                  :rows="3"
                  :placeholder="tokenPlaceholder"
                  class="font-mono"
                />
              </UFormField>
              <div class="flex justify-end">
                <UButton
                  :loading="busy"
                  :disabled="!token.trim()"
                  icon="i-lucide-plus"
                  @click="add()"
                >
                  Connect
                </UButton>
              </div>
            </div>

            <!-- connected pool -->
            <div v-if="creds.credentials.length" class="space-y-2">
              <h4 class="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Connected ({{ creds.credentials.length }})
              </h4>
              <div
                v-for="c in creds.credentials"
                :key="c.id"
                class="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm"
              >
                <div>
                  <span class="font-medium text-slate-200">{{ c.label }}</span>
                  <span class="ml-2 text-xs text-slate-500">{{ vendorLabel(c.vendor) }}</span>
                  <div class="text-[11px] tabular-nums text-slate-500">
                    {{ (c.inputTokens + c.outputTokens).toLocaleString() }} tok this window ·
                    {{ c.requestCount }} run{{ c.requestCount === 1 ? '' : 's' }}
                  </div>
                </div>
                <UButton
                  icon="i-lucide-trash-2"
                  color="error"
                  variant="ghost"
                  size="xs"
                  @click="remove(c.id)"
                />
              </div>
            </div>
          </div>
        </template>

        <!-- Direct provider API keys (OpenAI/Anthropic/Qwen/DeepSeek/Moonshot), pooled -->
        <template #direct>
          <ProvidersApiKeysSection category="direct" />
        </template>

        <!-- Proxies / gateways (OpenRouter, LiteLLM): intermediaries that front many vendors -->
        <template #proxy>
          <ProvidersApiKeysSection category="proxy" />
        </template>

        <!-- Personal (individual-usage) subscriptions: Claude / GLM / Codex, per-user -->
        <template #personal>
          <ProvidersPersonalSubscriptionSection />
        </template>
      </UTabs>
    </template>
  </UModal>
</template>
