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

// The permission ladder a minted key can carry (read ⊂ write ⊂ decide ⊂ admin), mirroring the
// backend contract. A `read` key can only observe; `write` adds create/start/manage; `decide` adds
// answering a run's PARKED human decisions (and, because of that, starting a headless run on a
// pipeline that can park at all); `admin` adds the destructive/merge-adjacent operations (e.g.
// deleting a task).
const SCOPES: PublicApiScope[] = ['read', 'write', 'decide', 'admin']

/** Localized label for a scope — an exhaustive switch, so a new scope is a compile error here. */
function scopeLabel(scope: PublicApiScope): string {
  switch (scope) {
    case 'read':
      return t('settings.apiTokens.scopes.read')
    case 'write':
      return t('settings.apiTokens.scopes.write')
    case 'decide':
      return t('settings.apiTokens.scopes.decide')
    case 'admin':
      return t('settings.apiTokens.scopes.admin')
  }
}

const scopeItems = computed(() => SCOPES.map((value) => ({ value, label: scopeLabel(value) })))
const ui = useUiStore()
const auth = useAuthStore()
const store = usePublicApiKeysStore()

/**
 * The minter to attribute a key to. When the minter is the signed-in user we show a localized
 * "you"; for another person, the raw `usr_*` id (the list has no user-name lookup, so the audit id
 * is the honest, non-misleading thing to show).
 *
 * A key PROVISIONED HEADLESSLY (`POST /api/v1/keys`) has no user and names the KEY that minted
 * it instead. Reading `createdByKeyId` here is not a nicety: a headless mint stores a null user,
 * so without this branch it would render exactly like a key that predates the audit column, and
 * "nobody knows who made this" would be shown for the one case the platform knows precisely.
 * `null` stays reserved for genuinely unattributed keys, where the row omits the segment.
 */
function minterLabel(key: PublicApiKey): string | null {
  if (key.createdByKeyId) {
    return t('settings.apiTokens.list.createdByKey', { id: key.createdByKeyId })
  }
  if (!key.createdByUserId) return null
  return key.createdByUserId === auth.user?.id
    ? t('settings.apiTokens.list.createdByYou')
    : key.createdByUserId
}
const toast = useToast()
const { present } = usePipelineErrorToast()
const { confirmAction, toastDone } = useConfirmAction()

const open = computed({
  get: () => ui.apiTokensOpen,
  set: (v: boolean) => (v ? ui.openApiTokens() : ui.closeApiTokens()),
})
const back = useIntegrationBack(open)

const label = ref('')
// The scope the next minted key will carry; defaults to the safe middle of the ladder.
const scope = ref<PublicApiScope>('write')
// WHO the next key runs as. Two named options rather than an unchecked box, because they are two
// different credentials with two different blast radii and neither is a mere setting on the other:
//
//  - `system` (the default): the token belongs to the workspace. Its runs are attributed to nobody
//    and it can reach no personal subscription, so a leaked shared credential can never spend one
//    person's Claude quota. This is what a CI job or a shared integration should hold.
//  - `self`: the token belongs to the person minting it. Its runs are theirs and may unlock their
//    personal Claude / Codex / GLM subscription, with the password sent on each such call.
//
// NOT gated on the interface mode, unlike an override field. This whole panel is the Integrations
// hub's Development surface, reached only by someone already minting an API key, and `scope` next
// to it is ungated for the same reason. Hiding it in basic mode would leave that person a key that
// silently cannot run their own models, with nothing on screen to say why.
type TokenIdentity = 'system' | 'self'
const identity = ref<TokenIdentity>('system')
// Nobody to bind on a board with no signed-in user (a dev-open deployment): the server refuses
// such a mint outright, so the choice is withheld and every key is a system key, which is what
// that deployment can honestly offer.
const canBindSelf = computed(() => auth.user !== null && auth.user !== undefined)
const identityItems = computed(() => [
  { value: 'system' as const, label: t('settings.apiTokens.add.identitySystem') },
  { value: 'self' as const, label: t('settings.apiTokens.add.identitySelf') },
])
/** The help text under the picker, so each option explains ITSELF rather than only its opposite. */
const identityHelp = computed(() =>
  identity.value === 'self'
    ? t('settings.apiTokens.add.identitySelfHelp')
    : t('settings.apiTokens.add.identitySystemHelp'),
)
const busy = ref(false)
// The full raw secret from the most recent create — surfaced once, then dismissed. Never
// re-fetchable, so it lives only in this transient ref (not the store).
const newSecret = ref<string | null>(null)

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
      present(e, 'settings.apiTokens.toast.loadFailed')
    }
  },
  { immediate: true },
)

async function createToken() {
  const trimmed = label.value.trim()
  if (!trimmed) return
  busy.value = true
  try {
    const created = await store.create(
      trimmed,
      scope.value,
      canBindSelf.value && identity.value === 'self',
    )
    newSecret.value = created.secret
    label.value = ''
    scope.value = 'write'
    identity.value = 'system'
    toast.add({
      title: t('settings.apiTokens.toast.created'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'settings.apiTokens.toast.createFailed')
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
    present(e, 'settings.apiTokens.toast.revokeFailed')
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
                <!-- Always shown, never mode-gated: an existing key can already carry the
                     binding, and this is the only place its holder can see that a token they
                     are about to hand out reaches a personal subscription. -->
                <UBadge
                  v-if="key.actsAsUserId"
                  color="warning"
                  variant="subtle"
                  size="sm"
                  :data-testid="`api-token-bound-${key.id}`"
                >
                  {{ t('settings.apiTokens.list.boundToUser') }}
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
                <template v-if="minterLabel(key)">
                  <span aria-hidden="true"> · </span>
                  {{ t('settings.apiTokens.list.createdBy', { user: minterLabel(key) }) }}
                </template>
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
          <UFormField
            v-if="canBindSelf"
            :label="t('settings.apiTokens.add.identity')"
            :help="identityHelp"
          >
            <USelect
              v-model="identity"
              :items="identityItems"
              class="w-full"
              data-testid="api-token-identity"
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
