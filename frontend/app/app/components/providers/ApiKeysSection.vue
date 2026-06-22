<script setup lang="ts">
// Direct-provider API keys: connect a vendor API key (OpenAI/Anthropic/Qwen/DeepSeek/
// Moonshot) so agent steps and inline calls run on that provider. Keys are stored
// encrypted in the DB, pooled and rotated by usage — replacing deployment env vars.
//
// Two modes:
//  - Default (no `accountId`): manage WORKSPACE keys (shared by the team) and YOUR own
//    keys (your personal pool, usable in any workspace), toggled by the Scope select.
//  - With `accountId`: manage ACCOUNT-wide keys (shared by every workspace in the
//    account); admin-only, enforced server-side. Surfaced from account/team settings.
import { computed, ref, watch } from 'vue'
import type { ApiKey, ApiKeyProvider } from '~/types/domain'

const props = defineProps<{ accountId?: string }>()

const workspace = useWorkspaceStore()
const keys = useApiKeysStore()
const models = useModelsStore()
const toast = useToast()

/** Account-wide mode (single account scope) vs the default workspace/user toggle. */
const isAccount = computed(() => !!props.accountId)

/** Where to obtain each provider's API key + a short note. */
const PROVIDERS: {
  value: ApiKeyProvider
  label: string
  url: string
  steps: string[]
}[] = [
  {
    value: 'openai',
    label: 'OpenAI',
    url: 'https://platform.openai.com/api-keys',
    steps: [
      'Open platform.openai.com → API keys and create a new secret key.',
      'Copy the key (starts with sk-…); it is shown only once.',
    ],
  },
  {
    value: 'anthropic',
    label: 'Anthropic (Claude API)',
    url: 'https://console.anthropic.com/settings/keys',
    steps: [
      'Open console.anthropic.com → Settings → API Keys and create a key.',
      'Copy the key (starts with sk-ant-…).',
    ],
  },
  {
    value: 'qwen',
    label: 'Qwen (Alibaba DashScope)',
    url: 'https://dashscope.console.aliyun.com/apiKey',
    steps: [
      'Open the DashScope console (international) → API-KEY and create a key.',
      'Copy the key; it authenticates the OpenAI-compatible Qwen endpoint.',
    ],
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    url: 'https://platform.deepseek.com/api_keys',
    steps: [
      'Open platform.deepseek.com → API keys and create a key.',
      'Copy the key (starts with sk-…).',
    ],
  },
  {
    value: 'moonshot',
    label: 'Moonshot (Kimi API)',
    url: 'https://platform.moonshot.ai/console/api-keys',
    steps: [
      'Open platform.moonshot.ai → API Keys and create a key.',
      'Copy the key; it authenticates the OpenAI-compatible Moonshot endpoint.',
    ],
  },
]

const scope = ref<'workspace' | 'user'>('workspace')
const provider = ref<ApiKeyProvider>('openai')
const label = ref('')
const key = ref('')
const busy = ref(false)

watch(
  () => props.accountId,
  (acc) => {
    if (acc) void keys.loadAccountKeys(acc)
  },
  { immediate: true },
)

watch(
  () => workspace.workspaceId,
  (ws) => {
    if (!isAccount.value && ws) void keys.load(ws)
  },
  { immediate: true },
)

const selected = computed(() => PROVIDERS.find((p) => p.value === provider.value)!)
const connected = computed<ApiKey[]>(() =>
  isAccount.value
    ? keys.accountKeys
    : scope.value === 'workspace'
      ? keys.workspaceKeys
      : keys.userKeys,
)

function providerLabel(p: ApiKeyProvider): string {
  return PROVIDERS.find((x) => x.value === p)?.label ?? p
}

async function add() {
  if (!key.value.trim()) return
  busy.value = true
  try {
    const input = {
      provider: provider.value,
      label: label.value.trim() || `${provider.value} key`,
      key: key.value.trim(),
    }
    if (isAccount.value) await keys.addAccountKey(input)
    else if (scope.value === 'workspace') await keys.addWorkspaceKey(input)
    else await keys.addUserKey(input)
    key.value = ''
    label.value = ''
    // The picker's selectability depends on configured keys — refresh it.
    if (workspace.workspaceId) await models.refresh(workspace.workspaceId)
    toast.add({ title: 'API key connected', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    toast.add({
      title: 'Could not connect key',
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    busy.value = false
  }
}

async function remove(k: ApiKey) {
  try {
    if (k.scope === 'account') await keys.removeAccountKey(k.id)
    else if (k.scope === 'workspace') await keys.removeWorkspaceKey(k.id)
    else await keys.removeUserKey(k.id)
    if (workspace.workspaceId) await models.refresh(workspace.workspaceId)
  } catch (e) {
    toast.add({
      title: 'Could not remove key',
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  }
}
</script>

<template>
  <div class="space-y-4">
    <div>
      <h4 class="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Direct provider API keys
      </h4>
      <p v-if="isAccount" class="mt-1 text-sm text-slate-400">
        Connect a vendor API key shared by <strong>every workspace</strong> in this account.
        Keys are stored encrypted, pooled, and rotated by usage. Account keys are admin-managed.
      </p>
      <p v-else class="mt-1 text-sm text-slate-400">
        Connect a vendor API key so models run directly on that provider. Keys are stored
        encrypted, pooled, and rotated by usage. Scope a key to this <strong>workspace</strong>
        (shared with the team) or to <strong>you</strong> (your own pool, usable anywhere).
      </p>
    </div>

    <!-- scope + provider -->
    <div class="flex flex-wrap items-end gap-3">
      <UFormField v-if="!isAccount" label="Scope">
        <USelect
          v-model="scope"
          :items="[
            { label: 'This workspace', value: 'workspace' },
            { label: 'My keys (only me)', value: 'user' },
          ]"
          class="w-48"
        />
      </UFormField>
      <UFormField label="Provider">
        <USelect
          v-model="provider"
          :items="PROVIDERS.map((p) => ({ label: p.label, value: p.value }))"
          class="w-64"
        />
      </UFormField>
    </div>

    <!-- where to get the key -->
    <ol
      class="list-decimal space-y-1.5 rounded-lg border border-slate-700 bg-slate-900/60 p-4 pl-8 text-sm text-slate-300"
    >
      <li v-for="(step, i) in selected.steps" :key="i">{{ step }}</li>
      <li>
        <a
          :href="selected.url"
          target="_blank"
          rel="noopener noreferrer"
          class="text-primary-400 underline"
        >
          Open {{ selected.label }} keys ↗
        </a>
      </li>
    </ol>

    <!-- add form -->
    <div class="space-y-2">
      <UFormField label="Label (optional)">
        <UInput v-model="label" placeholder="e.g. team key" />
      </UFormField>
      <UFormField label="API key">
        <UTextarea v-model="key" :rows="2" placeholder="paste the API key" class="font-mono" />
      </UFormField>
      <div class="flex justify-end">
        <UButton :loading="busy" :disabled="!key.trim()" icon="i-lucide-plus" @click="add()">
          Connect
        </UButton>
      </div>
    </div>

    <!-- connected keys for the selected scope -->
    <div v-if="connected.length" class="space-y-2">
      <h5 class="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Connected ({{ connected.length }})
      </h5>
      <div
        v-for="k in connected"
        :key="k.id"
        class="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm"
      >
        <div>
          <span class="font-medium text-slate-200">{{ k.label }}</span>
          <span class="ml-2 text-xs text-slate-500">{{ providerLabel(k.provider) }}</span>
          <div class="text-[11px] tabular-nums text-slate-500">
            {{ (k.inputTokens + k.outputTokens).toLocaleString() }} tok this window ·
            {{ k.requestCount }} call{{ k.requestCount === 1 ? '' : 's' }}
          </div>
        </div>
        <UButton
          icon="i-lucide-trash-2"
          color="error"
          variant="ghost"
          size="xs"
          @click="remove(k)"
        />
      </div>
    </div>
  </div>
</template>
