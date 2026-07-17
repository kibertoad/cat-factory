<script setup lang="ts">
// API access tokens — the workspace's inbound public-API keys external systems present to the
// `/api/v1` surface (`Authorization: Bearer cf_live_…`). Keys are hashed one-way server-side,
// so the raw secret is shown EXACTLY ONCE, on create; the list thereafter renders metadata
// only (label + created / last-used). To rotate a token, revoke it and mint a new one.
// Opened from the Integrations hub.
import { computed, ref, watch } from 'vue'
import type { PublicApiKey, PublicApiScope } from '~/types/publicApiKeys'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'
import CopyButton from '~/components/common/CopyButton.vue'

const { t, d } = useI18n()

// The permission ladder a minted key can carry (read ⊂ write ⊂ admin), mirroring the backend
// contract. A `read` key can only observe; `write` adds create/start/manage; `admin` adds the
// destructive/merge-adjacent operations (e.g. deleting a task).
const SCOPES: PublicApiScope[] = ['read', 'write', 'admin']

/** Localized label for a scope — an exhaustive switch, so a new scope is a compile error here. */
function scopeLabel(scope: PublicApiScope): string {
  switch (scope) {
    case 'read':
      return t('settings.apiTokens.scopes.read')
    case 'write':
      return t('settings.apiTokens.scopes.write')
    case 'admin':
      return t('settings.apiTokens.scopes.admin')
  }
}

const scopeItems = computed(() => SCOPES.map((value) => ({ value, label: scopeLabel(value) })))
const ui = useUiStore()
const store = usePublicApiKeysStore()
const toast = useToast()
const { confirmAction, toastDone } = useConfirmAction()

const open = computed({
  get: () => ui.apiTokensOpen,
  set: (v: boolean) => (v ? ui.openApiTokens() : ui.closeApiTokens()),
})
const back = useIntegrationBack(open)

const label = ref('')
// The scope the next minted key will carry; defaults to the safe middle of the ladder.
const scope = ref<PublicApiScope>('write')
const busy = ref(false)
// The full raw secret from the most recent create — surfaced once, then dismissed. Never
// re-fetchable, so it lives only in this transient ref (not the store).
const newSecret = ref<string | null>(null)

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

watch(
  open,
  async (isOpen) => {
    if (!isOpen) {
      // Never leave a revealed secret hanging around once the panel closes.
      newSecret.value = null
      return
    }
    try {
      await store.ensureLoaded()
    } catch (e) {
      notifyError(t('settings.apiTokens.toast.loadFailed'), e)
    }
  },
  { immediate: true },
)

async function createToken() {
  const trimmed = label.value.trim()
  if (!trimmed) return
  busy.value = true
  try {
    const created = await store.create(trimmed, scope.value)
    newSecret.value = created.secret
    label.value = ''
    scope.value = 'write'
    toast.add({
      title: t('settings.apiTokens.toast.created'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('settings.apiTokens.toast.createFailed'), e)
  } finally {
    busy.value = false
  }
}

function dismissSecret() {
  newSecret.value = null
}

async function revokeToken(key: PublicApiKey) {
  if (!(await confirmAction('revoke', key.label))) return
  busy.value = true
  try {
    await store.revoke(key.id)
    toastDone('revoke', key.label)
  } catch (e) {
    notifyError(t('settings.apiTokens.toast.revokeFailed'), e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="t('settings.apiTokens.title')" :ui="{ content: 'max-w-lg' }">
    <template #title>
      <IntegrationBackTitle :title="t('settings.apiTokens.title')" @back="back" />
    </template>
    <template #body>
      <div class="space-y-4" data-testid="api-tokens-panel">
        <p class="text-sm text-slate-400">
          {{ t('settings.apiTokens.intro') }}
        </p>

        <!-- One-time secret reveal: shown once after create, dismissed by the user. The full
             key is never recoverable, so it must be copied now. -->
        <section
          v-if="newSecret"
          class="space-y-2 rounded-lg border border-primary-500/40 bg-primary-500/10 p-3"
          data-testid="api-token-secret"
        >
          <div class="flex items-center gap-2 text-sm font-medium text-primary-200">
            <UIcon name="i-lucide-key-round" class="h-4 w-4 shrink-0" />
            <span>{{ t('settings.apiTokens.secret.heading') }}</span>
          </div>
          <p class="text-xs text-slate-300">{{ t('settings.apiTokens.secret.warning') }}</p>
          <div
            class="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-950/60 px-3 py-2"
          >
            <code class="min-w-0 flex-1 truncate font-mono text-xs text-slate-100">{{
              newSecret
            }}</code>
            <CopyButton :text="newSecret" :label="t('settings.apiTokens.secret.copy')" size="sm" />
          </div>
          <div class="flex justify-end">
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              data-testid="api-token-secret-dismiss"
              @click="dismissSecret"
            >
              {{ t('settings.apiTokens.secret.done') }}
            </UButton>
          </div>
        </section>

        <section v-if="store.keys.length" class="space-y-2 rounded-lg border border-slate-700 p-3">
          <h3 class="text-sm font-semibold">
            {{ t('settings.apiTokens.list.heading') }}
          </h3>
          <div
            v-for="key in store.keys"
            :key="key.id"
            class="flex items-center justify-between gap-2 rounded-md border border-slate-800 px-3 py-2"
          >
            <div class="min-w-0 space-y-0.5">
              <div class="flex items-center gap-2">
                <span class="truncate text-sm font-medium">{{ key.label }}</span>
                <UBadge
                  color="neutral"
                  variant="subtle"
                  size="sm"
                  :data-testid="`api-token-scope-${key.id}`"
                >
                  {{ scopeLabel(key.scope) }}
                </UBadge>
              </div>
              <div class="text-[11px] text-slate-500">
                {{
                  t('settings.apiTokens.list.created', {
                    date: d(new Date(key.createdAt), 'short'),
                  })
                }}
                <span aria-hidden="true"> · </span>
                <template v-if="key.lastUsedAt">{{
                  t('settings.apiTokens.list.lastUsed', {
                    date: d(new Date(key.lastUsedAt), 'short'),
                  })
                }}</template>
                <template v-else>{{ t('settings.apiTokens.list.neverUsed') }}</template>
              </div>
            </div>
            <UButton
              color="error"
              variant="ghost"
              icon="i-lucide-ban"
              size="sm"
              :loading="busy"
              :data-testid="`api-token-revoke-${key.id}`"
              :aria-label="t('settings.apiTokens.list.revoke')"
              @click="revokeToken(key)"
            />
          </div>
        </section>

        <section class="space-y-3 rounded-lg border border-slate-700 p-3">
          <h3 class="text-sm font-semibold">
            {{ t('settings.apiTokens.add.heading') }}
          </h3>
          <UFormField
            :label="t('settings.apiTokens.add.label')"
            :help="t('settings.apiTokens.add.labelHelp')"
          >
            <UInput
              v-model="label"
              :placeholder="t('settings.apiTokens.add.labelPlaceholder')"
              class="w-full"
              data-testid="api-token-label"
              @keyup.enter="createToken"
            />
          </UFormField>
          <UFormField
            :label="t('settings.apiTokens.add.scope')"
            :help="t('settings.apiTokens.add.scopeHelp')"
          >
            <USelect
              v-model="scope"
              :items="scopeItems"
              class="w-full"
              data-testid="api-token-scope"
            />
          </UFormField>
          <UButton
            :loading="busy"
            :disabled="!label.trim()"
            data-testid="api-token-create"
            @click="createToken"
          >
            {{ t('settings.apiTokens.add.create') }}
          </UButton>
        </section>
      </div>
    </template>
  </UModal>
</template>
