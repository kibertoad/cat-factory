<script setup lang="ts">
// "OpenRouter" — the one-stop OpenRouter setup panel. OpenRouter is a single gateway to
// 300+ models reached via the workspace's API-key pool, so this panel owns the whole flow:
//  1. Connect an OpenRouter key inline (no need to detour through Vendors & keys).
//  2. The live catalog auto-refreshes as soon as a key exists.
//  3. Tick models (or one-click "Enable recommended") and Save.
// Enabled models — with their context window and price — appear in the model picker and
// meter against the spend budget. The Vendors & keys → Proxies tab remains a valid second
// entry point for the key; this panel just makes OpenRouter self-sufficient.
import { computed, ref, watch } from 'vue'
import type { OpenRouterModelMeta } from '~/types/openrouter'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'
import SecretInput from '~/components/common/SecretInput.vue'

const { t } = useI18n()
const ui = useUiStore()
const workspace = useWorkspaceStore()
const store = useOpenRouterStore()
const apiKeys = useApiKeysStore()
const models = useModelsStore()
const toast = useToast()

const open = computed({
  get: () => ui.openRouterOpen,
  set: (v: boolean) => (v ? ui.openOpenRouter() : ui.closeOpenRouter()),
})
const back = useIntegrationBack(open)

// Popular slugs offered by "Enable recommended" — these mirror the curated `openrouter`
// refs in the backend MODEL_CATALOG. Only the ones present in the live browse list are
// ticked, so a recommendation never enables a slug OpenRouter doesn't actually serve.
const RECOMMENDED_SLUGS = [
  'anthropic/claude-fable-5',
  'anthropic/claude-opus-4.8',
  'openai/gpt-5.5',
  'google/gemini-3-pro',
  'deepseek/deepseek-chat',
  'moonshotai/kimi-k2.7-code',
]

// Whether the workspace/user has an OpenRouter key connected at any reachable scope.
const keyConnected = computed(() => apiKeys.configuredProviders.has('openrouter'))

// The enabled slugs the user has ticked (seeded from the persisted catalog on open).
const selected = ref<Set<string>>(new Set())
const filter = ref('')
const busy = ref(false)

// Inline key-entry form state (shown until an OpenRouter key is connected).
const keyScope = ref<'workspace' | 'user'>('workspace')
const keyLabel = ref('')
const keyValue = ref('')
const connectingKey = ref(false)

// Load key state + persisted catalog whenever the panel opens; seed the tick selection,
// then auto-refresh the live catalog if a key is already connected (no extra click).
watch(
  open,
  (isOpen) => {
    // Lazy v-if mount runs this immediately (see below); guard still skips the closed case.
    if (!isOpen || !workspace.workspaceId) return
    const ws = workspace.workspaceId
    void apiKeys.load(ws).catch(() => {})
    void store.load(ws).then(() => {
      selected.value = new Set(store.enabled.map((m) => m.id))
      if (keyConnected.value && store.browse.length === 0) void refresh()
    })
  },
  { immediate: true },
)

// The list to show: the live browse list once refreshed, else the persisted enabled set.
const source = computed<OpenRouterModelMeta[]>(() =>
  store.browse.length ? store.browse : store.enabled,
)

const visible = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return source.value
  return source.value.filter(
    (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
  )
})

const selectedCount = computed(() => selected.value.size)

// Recommended slugs that are actually available in the current browse/enabled list.
const recommendedAvailable = computed(() => {
  const ids = new Set(source.value.map((m) => m.id))
  return RECOMMENDED_SLUGS.filter((slug) => ids.has(slug))
})

function contextLabel(tokens: number | undefined): string {
  if (!tokens) return ''
  return tokens >= 1000
    ? t('settings.openRouterCatalog.contextThousands', { value: Math.round(tokens / 1000) })
    : t('settings.openRouterCatalog.context', { value: tokens })
}

function priceLabel(m: OpenRouterModelMeta): string {
  return t('settings.openRouterCatalog.price', {
    input: m.inputPerMillion,
    output: m.outputPerMillion,
  })
}

function toggle(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}

function enableRecommended() {
  const next = new Set(selected.value)
  for (const slug of recommendedAvailable.value) next.add(slug)
  selected.value = next
}

async function connectKey() {
  if (!keyValue.value.trim() || !workspace.workspaceId) return
  connectingKey.value = true
  try {
    const scope = keyScope.value
    const input = {
      provider: 'openrouter' as const,
      label: keyLabel.value.trim() || 'openrouter key',
      key: keyValue.value.trim(),
    }
    // The save endpoint stores the key WITHOUT validating it, so a wrong/expired key
    // would otherwise be reported as "connected". Probe OpenRouter with the freshly
    // stored key and only announce success when it's actually reachable; on rejection
    // roll the key back so `keyConnected` stays false and the form remains for a retry.
    const created =
      scope === 'workspace' ? await apiKeys.addWorkspaceKey(input) : await apiKeys.addUserKey(input)
    const result = await store.refresh(workspace.workspaceId)
    if (!result.reachable) {
      if (created) {
        if (scope === 'workspace') await apiKeys.removeWorkspaceKey(created.id).catch(() => {})
        else await apiKeys.removeUserKey(created.id).catch(() => {})
      }
      toast.add({
        title: t('settings.openRouterCatalog.toast.connectFailed'),
        description: store.refreshError ?? t('settings.openRouterCatalog.toast.rejected'),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
      return
    }
    keyValue.value = ''
    keyLabel.value = ''
    toast.add({
      title: t('settings.openRouterCatalog.toast.connected'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: t('settings.openRouterCatalog.toast.connectFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    connectingKey.value = false
  }
}

async function refresh() {
  if (!workspace.workspaceId) return
  const result = await store.refresh(workspace.workspaceId)
  if (!result.reachable) {
    toast.add({
      title: t('settings.openRouterCatalog.toast.unreachable'),
      description: store.refreshError ?? t('settings.openRouterCatalog.toast.connectFirst'),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}

async function save() {
  if (!workspace.workspaceId) return
  busy.value = true
  try {
    // Persist the ticked models, carrying the metadata from whichever list they came from.
    const byId = new Map(source.value.map((m) => [m.id, m]))
    const models2 = [...selected.value]
      .map((id) => byId.get(id))
      .filter((m): m is OpenRouterModelMeta => !!m)
    await store.save(workspace.workspaceId, models2)
    // Reflect newly-enabled models in the picker immediately.
    await models.refresh(workspace.workspaceId)
    toast.add({
      title: t('settings.openRouterCatalog.toast.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    toast.add({
      title: t('settings.openRouterCatalog.toast.saveFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    busy.value = false
  }
}

function manageKeys() {
  ui.closeOpenRouter()
  ui.openVendorCredentials()
}
</script>

<template>
  <UModal v-model:open="open" title="OpenRouter" :ui="{ content: 'max-w-2xl' }">
    <template #title>
      <IntegrationBackTitle title="OpenRouter" @back="back" />
    </template>
    <template #body>
      <div class="space-y-4">
        <p class="text-xs text-slate-400">
          <i18n-t keypath="settings.openRouterCatalog.intro" tag="span" scope="global">
            <template #models>
              <strong>{{ t('settings.openRouterCatalog.introModels') }}</strong>
            </template>
          </i18n-t>
        </p>

        <!-- Step 1: connect a key (inline) — hidden once a key is connected -->
        <div
          v-if="!keyConnected"
          class="space-y-3 rounded-lg border border-slate-700 bg-slate-900/60 p-4"
        >
          <h4 class="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {{ t('settings.openRouterCatalog.connectHeading') }}
          </h4>
          <ol class="list-decimal space-y-1 ps-5 text-sm text-slate-300">
            <li>
              <i18n-t keypath="settings.openRouterCatalog.step1" tag="span" scope="global">
                <template #link>
                  <a
                    href="https://openrouter.ai/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-primary-400 underline"
                    >{{ t('settings.openRouterCatalog.step1Link') }}</a
                  >
                </template>
              </i18n-t>
            </li>
            <li>
              <i18n-t keypath="settings.openRouterCatalog.step2" tag="span" scope="global">
                <template #prefix>
                  <span class="font-mono">sk-or-…</span>
                </template>
              </i18n-t>
            </li>
          </ol>
          <div class="flex flex-wrap items-end gap-3">
            <UFormField :label="t('settings.openRouterCatalog.scope')">
              <USelect
                v-model="keyScope"
                :items="[
                  { label: t('settings.openRouterCatalog.scopeWorkspace'), value: 'workspace' },
                  { label: t('settings.openRouterCatalog.scopeUser'), value: 'user' },
                ]"
                class="w-48"
              />
            </UFormField>
            <UFormField :label="t('settings.openRouterCatalog.labelOptional')" class="flex-1">
              <UInput
                v-model="keyLabel"
                :placeholder="t('settings.openRouterCatalog.labelPlaceholder')"
              />
            </UFormField>
          </div>
          <UFormField :label="t('settings.openRouterCatalog.apiKey')">
            <SecretInput
              v-model="keyValue"
              placeholder="paste your OpenRouter key (sk-or-…)"
              class="w-full font-mono"
            />
          </UFormField>
          <div class="flex justify-end">
            <UButton
              :loading="connectingKey"
              :disabled="!keyValue.trim()"
              icon="i-lucide-plus"
              @click="connectKey()"
            >
              {{ t('settings.openRouterCatalog.connectAndBrowse') }}
            </UButton>
          </div>
        </div>

        <!-- Key connected status -->
        <div
          v-else
          class="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm"
        >
          <span class="flex items-center gap-2 text-slate-300">
            <UIcon name="i-lucide-check-circle" class="h-4 w-4 text-emerald-400" />
            {{ t('settings.openRouterCatalog.keyConnected') }}
          </span>
          <UButton color="neutral" variant="ghost" size="xs" @click="manageKeys()">
            {{ t('settings.openRouterCatalog.manageKeys') }}
          </UButton>
        </div>

        <!-- Step 2: browse + enable models (only once a key exists) -->
        <template v-if="keyConnected">
          <div class="flex items-center gap-2">
            <UButton
              color="neutral"
              variant="soft"
              size="sm"
              icon="i-lucide-refresh-cw"
              :loading="store.refreshing"
              @click="refresh()"
            >
              {{ t('settings.openRouterCatalog.refresh') }}
            </UButton>
            <UButton
              v-if="recommendedAvailable.length"
              color="primary"
              variant="soft"
              size="sm"
              icon="i-lucide-sparkles"
              @click="enableRecommended()"
            >
              {{ t('settings.openRouterCatalog.enableRecommended') }}
            </UButton>
            <UInput
              v-model="filter"
              size="sm"
              class="flex-1"
              icon="i-lucide-search"
              :placeholder="t('settings.openRouterCatalog.filterPlaceholder')"
            />
          </div>

          <p v-if="store.refreshError" class="text-xs text-rose-400">{{ store.refreshError }}</p>

          <div v-if="visible.length" class="max-h-96 space-y-1 overflow-y-auto pe-1">
            <label
              v-for="m in visible"
              :key="m.id"
              class="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/40 px-2.5 py-1.5 text-sm"
            >
              <UCheckbox
                :model-value="selected.has(m.id)"
                @update:model-value="(v: boolean | 'indeterminate') => toggle(m.id, v === true)"
              />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-slate-200">{{ m.name }}</span>
                <span class="block truncate font-mono text-[11px] text-slate-500">{{ m.id }}</span>
              </span>
              <span class="shrink-0 text-end text-[11px] text-slate-500">
                <span v-if="m.contextLength" class="block">{{
                  contextLabel(m.contextLength)
                }}</span>
                <span class="block">{{ priceLabel(m) }}</span>
              </span>
            </label>
          </div>
          <p v-else class="text-xs text-slate-500">
            <i18n-t keypath="settings.openRouterCatalog.empty" tag="span" scope="global">
              <template #action>
                <span class="text-slate-300">{{ t('settings.openRouterCatalog.refresh') }}</span>
              </template>
            </i18n-t>
          </p>

          <div class="flex items-center justify-between">
            <span class="text-xs text-slate-500">{{
              t('settings.openRouterCatalog.enabledCount', { count: selectedCount }, selectedCount)
            }}</span>
            <UButton
              color="primary"
              variant="soft"
              size="sm"
              icon="i-lucide-save"
              :loading="busy"
              @click="save()"
            >
              {{ t('common.save') }}
            </UButton>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
