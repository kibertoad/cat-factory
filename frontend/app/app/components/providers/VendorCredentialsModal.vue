<script setup lang="ts">
// LLM Vendors: connect subscription credentials (a token pool) so agent steps can
// run on the Claude Code / Codex harnesses instead of an API key. Guided,
// vendor-specific instructions (OS-specific for Codex); tokens are write-only and
// pooled, leased with usage-aware rotation. Connecting a vendor makes its models
// win in the picker and at dispatch ("subscriptions always win").
import { computed, ref, watch } from 'vue'
import type { SubscriptionVendor } from '~/types/domain'

const ui = useUiStore()
const workspace = useWorkspaceStore()
const creds = useVendorCredentialsStore()
const toast = useToast()

const open = computed({
  get: () => ui.vendorCredentialsOpen,
  set: (v: boolean) => (v ? ui.openVendorCredentials() : ui.closeVendorCredentials()),
})

type Os = 'mac' | 'linux' | 'windows'

const VENDORS: { value: SubscriptionVendor; label: string; harness: string }[] = [
  { value: 'claude', label: 'Claude (Pro/Max)', harness: 'Claude Code' },
  { value: 'glm', label: 'GLM — Z.ai coding plan', harness: 'Claude Code' },
  { value: 'kimi', label: 'Kimi — Moonshot coding plan', harness: 'Claude Code' },
  { value: 'codex', label: 'ChatGPT (Plus/Pro)', harness: 'Codex' },
]

const vendor = ref<SubscriptionVendor>('claude')
const os = ref<Os>('mac')
const label = ref('')
const token = ref('')
const busy = ref(false)

watch(open, (isOpen) => {
  if (isOpen && workspace.workspaceId) void creds.load(workspace.workspaceId)
})

const codexPath = computed(
  () =>
    ({
      mac: '~/.codex/auth.json',
      linux: '~/.codex/auth.json',
      windows: '%USERPROFILE%\\.codex\\auth.json',
    })[os.value],
)

/** Step-by-step instructions for the selected vendor (+ OS for Codex). */
const steps = computed<string[]>(() => {
  switch (vendor.value) {
    case 'claude':
      return [
        'Install Claude Code and sign in with your Claude Pro/Max account: run `claude` once and complete the browser login.',
        'Generate a long-lived token: run `claude setup-token` and copy the printed token.',
        'Paste the token below. It authenticates Claude Code against api.anthropic.com on your subscription.',
      ]
    case 'glm':
      return [
        'Open your Z.ai coding-plan dashboard and create an API key for the Anthropic-compatible endpoint.',
        'Copy the API key. Agent steps will run via Claude Code against Z.ai’s Anthropic endpoint with full context.',
        'Paste the key below.',
      ]
    case 'kimi':
      return [
        'Open your Moonshot (Kimi) coding-plan console and create an API key for the Anthropic-compatible endpoint.',
        'Copy the API key. Agent steps will run via Claude Code against Moonshot’s Anthropic endpoint with full context.',
        'Paste the key below.',
      ]
    case 'codex':
      return [
        'Install the Codex CLI and sign in with your ChatGPT account: run `codex login` and complete the browser flow.',
        `Open the credentials file Codex wrote at ${codexPath.value} (set \`cli_auth_credentials_store = "file"\` in ~/.codex/config.toml first if it used the OS keychain).`,
        'Copy the entire contents of auth.json and paste it below.',
      ]
  }
})

const tokenPlaceholder = computed(() =>
  vendor.value === 'codex'
    ? '{ "auth_mode": "chatgpt", "tokens": { … } }'
    : vendor.value === 'claude'
      ? 'sk-ant-oat01-…'
      : 'your coding-plan API key',
)

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
    <template #body>
      <div class="space-y-5">
        <p class="text-sm text-slate-400">
          Connect a subscription to run agent steps on the Claude Code / Codex harnesses instead of
          an API key. Tokens are stored encrypted, pooled, and rotated by usage. Subscription models
          are flat-rate quota — they don’t draw on your spend budget.
        </p>

        <!-- vendor + (codex) OS pickers -->
        <div class="flex flex-wrap items-end gap-3">
          <UFormField label="Vendor">
            <USelect
              v-model="vendor"
              :items="VENDORS.map((v) => ({ label: v.label, value: v.value }))"
              class="w-64"
            />
          </UFormField>
          <UFormField v-if="vendor === 'codex'" label="Your OS">
            <USelect
              v-model="os"
              :items="[
                { label: 'macOS', value: 'mac' },
                { label: 'Linux', value: 'linux' },
                { label: 'Windows', value: 'windows' },
              ]"
              class="w-40"
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
            <UButton :loading="busy" :disabled="!token.trim()" icon="i-lucide-plus" @click="add()">
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
  </UModal>
</template>
