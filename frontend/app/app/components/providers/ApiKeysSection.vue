<script setup lang="ts">
// Provider API keys: connect a vendor API key so agent steps and inline calls run on
// that provider. Keys are stored encrypted in the DB, pooled and rotated by usage —
// replacing deployment env vars.
//
// `category` splits the providers into two kinds:
//  - 'direct' (default): you reach the vendor directly (OpenAI/Anthropic/Qwen/DeepSeek/
//    Moonshot).
//  - 'proxy': an intermediary gateway that fronts many vendors behind one key
//    (OpenRouter, LiteLLM). These are NOT direct vendors, so they get their own section.
//
// Two scopes:
//  - Default (no `accountId`): manage WORKSPACE keys (shared by the team) and YOUR own
//    keys (your personal pool, usable in any workspace), toggled by the Scope select.
//  - With `accountId`: manage ACCOUNT-wide keys (shared by every workspace in the
//    account); admin-only, enforced server-side. Surfaced from account/team settings.
import { computed, ref, watch } from 'vue'
import type { ApiKey, ApiKeyProvider } from '~/types/domain'
import SecretInput from '~/components/common/SecretInput.vue'

const props = withDefaults(defineProps<{ accountId?: string; category?: 'direct' | 'proxy' }>(), {
  category: 'direct',
})

const { t, n } = useI18n()
const workspace = useWorkspaceStore()
const keys = useApiKeysStore()
const models = useModelsStore()
const auth = useAuthStore()
const toast = useToast()
const { confirmAction, toastDone } = useConfirmAction()

/** Account-wide mode (single account scope) vs the default workspace/user toggle. */
const isAccount = computed(() => !!props.accountId)

// "My keys" (user scope) are stored per-user, so they need a signed-in user. Block just
// that scope when there's none (a deployment without sign-in); workspace/account keys are
// unaffected. The scope toggle stays enabled so the user can switch back to a shared scope.
const needsSignIn = computed(() => !isAccount.value && scope.value === 'user' && !auth.user)

interface ProviderMeta {
  value: ApiKeyProvider
  label: string
  url: string
  steps: string[]
  /**
   * Whether this provider caches the re-sent prompt prefix. Connecting a key here
   * upgrades its models to the caching `direct` flavour, so a long agentic run stops
   * re-billing its whole growing prompt every turn. Mirrors the backend
   * `providerCachePolicy`; the gateways are pass-through (no caching we rely on yet).
   */
  caches?: boolean
}

// Provider metadata. Labels + step instructions resolve through i18n (reactive to the
// locale), so each `t(...)` uses a literal key (kept tier-1 typed-key checkable); only the
// `value`/`url`/`caches` differentiators stay inline.
/** Direct vendors: the key reaches that one vendor's own endpoint. */
const DIRECT_PROVIDERS = computed<ProviderMeta[]>(() => [
  {
    value: 'openai',
    label: t('providers.apiKeys.providers.openai.label'),
    url: 'https://platform.openai.com/api-keys',
    steps: [
      t('providers.apiKeys.providers.openai.step1'),
      t('providers.apiKeys.providers.openai.step2'),
    ],
    caches: true,
  },
  {
    value: 'anthropic',
    label: t('providers.apiKeys.providers.anthropic.label'),
    url: 'https://console.anthropic.com/settings/keys',
    steps: [
      t('providers.apiKeys.providers.anthropic.step1'),
      t('providers.apiKeys.providers.anthropic.step2'),
    ],
    caches: true,
  },
  {
    value: 'qwen',
    label: t('providers.apiKeys.providers.qwen.label'),
    url: 'https://dashscope.console.aliyun.com/apiKey',
    steps: [
      t('providers.apiKeys.providers.qwen.step1'),
      t('providers.apiKeys.providers.qwen.step2'),
    ],
    caches: true,
  },
  {
    value: 'deepseek',
    label: t('providers.apiKeys.providers.deepseek.label'),
    url: 'https://platform.deepseek.com/api_keys',
    steps: [
      t('providers.apiKeys.providers.deepseek.step1'),
      t('providers.apiKeys.providers.deepseek.step2'),
    ],
    caches: true,
  },
  {
    value: 'moonshot',
    label: t('providers.apiKeys.providers.moonshot.label'),
    url: 'https://platform.moonshot.ai/console/api-keys',
    steps: [
      t('providers.apiKeys.providers.moonshot.step1'),
      t('providers.apiKeys.providers.moonshot.step2'),
    ],
  },
])

/** Proxies / gateways: one key fronts many vendors. These are intermediaries, not vendors. */
const PROXY_PROVIDERS = computed<ProviderMeta[]>(() => [
  {
    value: 'openrouter',
    label: t('providers.apiKeys.providers.openrouter.label'),
    url: 'https://openrouter.ai/keys',
    steps: [
      t('providers.apiKeys.providers.openrouter.step1'),
      t('providers.apiKeys.providers.openrouter.step2'),
    ],
  },
  {
    value: 'litellm',
    label: t('providers.apiKeys.providers.litellm.label'),
    url: 'https://docs.litellm.ai/docs/proxy/virtual_keys',
    steps: [
      t('providers.apiKeys.providers.litellm.step1'),
      t('providers.apiKeys.providers.litellm.step2'),
    ],
  },
])

/** Providers for the requested category; labels everywhere fall back to the full set. */
const PROVIDERS = computed(() =>
  props.category === 'proxy' ? PROXY_PROVIDERS.value : DIRECT_PROVIDERS.value,
)
const ALL_PROVIDERS = computed(() => [...DIRECT_PROVIDERS.value, ...PROXY_PROVIDERS.value])

const scope = ref<'workspace' | 'user'>('workspace')
const provider = ref<ApiKeyProvider>(props.category === 'proxy' ? 'openrouter' : 'openai')
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

const selected = computed(
  () => PROVIDERS.value.find((p) => p.value === provider.value) ?? PROVIDERS.value[0]!,
)

/** Keys for the active scope, narrowed to this section's category (direct vs proxy). */
const categoryProviders = computed(() => new Set(PROVIDERS.value.map((p) => p.value)))
const connected = computed<ApiKey[]>(() => {
  const all = isAccount.value
    ? keys.accountKeys
    : scope.value === 'workspace'
      ? keys.workspaceKeys
      : keys.userKeys
  return all.filter((k) => categoryProviders.value.has(k.provider))
})

function providerLabel(p: ApiKeyProvider): string {
  return ALL_PROVIDERS.value.find((x) => x.value === p)?.label ?? p
}

async function add() {
  if (!key.value.trim()) return
  busy.value = true
  try {
    const input = {
      provider: provider.value,
      label:
        label.value.trim() || t('providers.apiKeys.defaultLabel', { provider: provider.value }),
      key: key.value.trim(),
    }
    if (isAccount.value) await keys.addAccountKey(input)
    else if (scope.value === 'workspace') await keys.addWorkspaceKey(input)
    else await keys.addUserKey(input)
    key.value = ''
    label.value = ''
    // The picker's selectability depends on configured keys — refresh it.
    if (workspace.workspaceId) await models.refresh(workspace.workspaceId)
    toast.add({
      title: t('providers.apiKeys.toast.connected'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: t('providers.apiKeys.toast.connectFailed'),
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    busy.value = false
  }
}

/** Route an update to the scope the key lives in (account / workspace / user). */
async function updateKey(k: ApiKey, patch: { enabled?: boolean; isDefault?: boolean }) {
  try {
    if (k.scope === 'account') await keys.updateAccountKey(k.id, patch)
    else if (k.scope === 'workspace') await keys.updateWorkspaceKey(k.id, patch)
    else await keys.updateUserKey(k.id, patch)
    // Enabling/disabling changes provider selectability in the picker — refresh it.
    if (workspace.workspaceId) await models.refresh(workspace.workspaceId)
  } catch (e) {
    toast.add({
      title: t('providers.apiKeys.toast.updateFailed'),
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  }
}

async function remove(k: ApiKey) {
  const noun = t('providers.apiKeys.keyNoun')
  if (!(await confirmAction('remove', noun))) return
  try {
    if (k.scope === 'account') await keys.removeAccountKey(k.id)
    else if (k.scope === 'workspace') await keys.removeWorkspaceKey(k.id)
    else await keys.removeUserKey(k.id)
    if (workspace.workspaceId) await models.refresh(workspace.workspaceId)
    toastDone('remove', noun)
  } catch (e) {
    toast.add({
      title: t('providers.apiKeys.toast.removeFailed'),
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
        {{
          category === 'proxy'
            ? t('providers.apiKeys.proxyHeading')
            : t('providers.apiKeys.directHeading')
        }}
      </h4>
      <template v-if="category === 'proxy'">
        <p v-if="isAccount" class="mt-1 text-sm text-slate-400">
          {{ t('providers.apiKeys.proxyAccountIntro') }}
        </p>
        <p v-else class="mt-1 text-sm text-slate-400">
          {{ t('providers.apiKeys.proxyIntro') }}
        </p>
      </template>
      <template v-else>
        <p v-if="isAccount" class="mt-1 text-sm text-slate-400">
          {{ t('providers.apiKeys.directAccountIntro') }}
        </p>
        <p v-else class="mt-1 text-sm text-slate-400">
          {{ t('providers.apiKeys.directIntro') }}
        </p>
      </template>
    </div>

    <!-- scope + provider -->
    <div class="flex flex-wrap items-end gap-3">
      <UFormField v-if="!isAccount" :label="t('providers.apiKeys.scopeField')">
        <USelect
          v-model="scope"
          :items="[
            { label: t('providers.apiKeys.scopeWorkspace'), value: 'workspace' },
            { label: t('providers.apiKeys.scopeUser'), value: 'user' },
          ]"
          class="w-48"
        />
      </UFormField>
      <UFormField
        :label="
          category === 'proxy'
            ? t('providers.apiKeys.proxyField')
            : t('providers.apiKeys.providerField')
        "
      >
        <USelect
          v-model="provider"
          :items="PROVIDERS.map((p) => ({ label: p.label, value: p.value }))"
          :disabled="needsSignIn"
          class="w-64"
        />
      </UFormField>
    </div>

    <ProvidersSignInRequiredNotice
      v-if="needsSignIn"
      :message="t('auth.signInRequired.userApiKeys')"
    />

    <!-- where to get the key -->
    <ol
      class="list-decimal space-y-1.5 rounded-lg border border-slate-700 bg-slate-900/60 p-4 ps-8 text-sm text-slate-300"
    >
      <li v-for="(step, i) in selected.steps" :key="i">{{ step }}</li>
      <li>
        <a
          :href="selected.url"
          target="_blank"
          rel="noopener noreferrer"
          class="text-primary-400 underline"
        >
          {{ t('providers.apiKeys.openKeys', { provider: selected.label }) }}
        </a>
      </li>
    </ol>

    <!-- caching capability: connecting a direct key that caches upgrades its models to
         the caching flavour, so long agentic runs stop re-billing the whole prompt. -->
    <p v-if="selected.caches" class="flex items-center gap-1.5 text-[12px] text-emerald-400/90">
      <UIcon name="i-lucide-zap" class="h-3.5 w-3.5 shrink-0" />
      {{ t('providers.apiKeys.cachingNote', { provider: selected.label }) }}
    </p>

    <!-- add form -->
    <div class="space-y-2">
      <UFormField :label="t('providers.apiKeys.labelField')">
        <UInput
          v-model="label"
          :disabled="needsSignIn"
          :placeholder="t('providers.apiKeys.labelPlaceholder')"
        />
      </UFormField>
      <UFormField :label="t('providers.apiKeys.keyField')">
        <SecretInput
          v-model="key"
          :disabled="needsSignIn"
          :placeholder="t('providers.apiKeys.keyPlaceholder')"
          class="w-full font-mono"
        />
      </UFormField>
      <div class="flex justify-end">
        <UButton
          :loading="busy"
          :disabled="needsSignIn || !key.trim()"
          icon="i-lucide-plus"
          @click="add()"
        >
          {{ t('providers.apiKeys.connect') }}
        </UButton>
      </div>
    </div>

    <!-- connected keys for the selected scope -->
    <div v-if="connected.length" class="space-y-2">
      <h5 class="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {{ t('providers.apiKeys.connected', { count: connected.length }) }}
      </h5>
      <div
        v-for="k in connected"
        :key="k.id"
        class="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm"
        :class="{ 'opacity-55': !k.enabled }"
      >
        <div>
          <span class="font-medium text-slate-200">{{ k.label }}</span>
          <span class="ms-2 text-xs text-slate-500">{{ providerLabel(k.provider) }}</span>
          <UBadge v-if="!k.enabled" color="neutral" variant="subtle" size="sm" class="ms-2">
            {{ t('providers.apiKeys.disabledBadge') }}
          </UBadge>
          <div class="text-[11px] tabular-nums text-slate-500">
            {{
              t(
                'providers.apiKeys.usage',
                { tokens: n(k.inputTokens + k.outputTokens, 'decimal'), count: k.requestCount },
                k.requestCount,
              )
            }}
          </div>
        </div>
        <div class="flex items-center gap-2">
          <UButton
            :icon="k.isDefault ? 'i-lucide-star' : 'i-lucide-star-off'"
            :color="k.isDefault ? 'primary' : 'neutral'"
            :variant="k.isDefault ? 'subtle' : 'ghost'"
            size="xs"
            @click="updateKey(k, { isDefault: !k.isDefault })"
          >
            {{
              k.isDefault ? t('providers.apiKeys.defaultBadge') : t('providers.apiKeys.pinDefault')
            }}
          </UButton>
          <USwitch
            :model-value="k.enabled"
            size="sm"
            :aria-label="t('providers.apiKeys.enableToggle')"
            @update:model-value="(v: boolean) => updateKey(k, { enabled: v })"
          />
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
  </div>
</template>
