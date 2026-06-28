<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { apiErrorEnvelope } from '~/composables/api/errors'
import type { AccountRole } from '~/types/domain'
import type { InvitationStatus } from '@cat-factory/contracts'
import AccountDeploymentSettings from '~/components/layout/AccountDeploymentSettings.vue'

// Team settings for an org account: the member roster (with combinable admin /
// developer / product roles), pending email invitations, and the per-account
// transactional-email sender. Admin-only mutations are enforced by the backend; this
// surface degrades to a read-only view when the caller isn't an admin (actions 4xx).
const props = defineProps<{ accountId: string }>()

const accounts = useAccountsStore()
const toast = useToast()
const { t, te } = useI18n()
const busy = ref(false)

const ROLE_ITEMS = computed<{ label: string; value: AccountRole }[]>(() => [
  { label: t('layout.accountTeam.roles.admin'), value: 'admin' },
  { label: t('layout.accountTeam.roles.developer'), value: 'developer' },
  { label: t('layout.accountTeam.roles.product'), value: 'product' },
])

const EMAIL_PROVIDER_ITEMS = computed(() => [
  { label: t('layout.accountTeam.email.providers.resend'), value: 'resend' as const },
  { label: t('layout.accountTeam.email.providers.sendgrid'), value: 'sendgrid' as const },
])

// Invitation status is a closed contract union; map each member to a literal key so the
// typed-message-key check stays live, with a te()-guarded fallback if a locale omits one.
const INVITATION_STATUS_KEYS: Record<InvitationStatus, string> = {
  pending: 'layout.accountTeam.invite.status.pending',
  accepted: 'layout.accountTeam.invite.status.accepted',
  revoked: 'layout.accountTeam.invite.status.revoked',
}
function invitationStatusLabel(status: InvitationStatus): string {
  const key = INVITATION_STATUS_KEYS[status]
  return te(key) ? t(key) : status
}

/** Whether the signed-in caller is an admin of this account (drives edit affordances). */
const isAdmin = computed(() => accounts.activeAccount?.roles?.includes('admin') ?? false)
/**
 * Members / roles / invitations are org-scoped — the backend rejects membership on a
 * personal account. For a personal account we show a "create an organization" CTA in
 * their place; the email sender + account API keys remain available either way.
 */
const isOrg = computed(() => accounts.activeAccount?.type === 'org')

async function updateMemberRoles(userId: string, roles: AccountRole[]) {
  try {
    await accounts.setMemberRoles(props.accountId, userId, roles.length ? roles : ['developer'])
  } catch (e) {
    notifyError(t('layout.accountTeam.errors.updateRoles'), e)
  }
}

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: apiErrorEnvelope(e)?.message ?? (e instanceof Error ? e.message : String(e)),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

async function loadAll(accountId: string) {
  try {
    const jobs: Promise<unknown>[] = [accounts.loadEmailConnection(accountId)]
    // The roster only applies to org accounts.
    if (isOrg.value) jobs.push(accounts.loadRoster(accountId))
    await Promise.all(jobs)
  } catch (e) {
    notifyError(t('layout.accountTeam.errors.loadSettings'), e)
  }
}

onMounted(() => void loadAll(props.accountId))
// Reload when the active account changes while the panel is open (e.g. after creating an
// organization from the CTA below, which switches the active account to the new org).
watch(
  () => props.accountId,
  (id) => {
    if (id) void loadAll(id)
  },
)

// ---- create organization (personal-account CTA) ---------------------------
const newOrgName = ref('')

async function createOrganization() {
  const name = newOrgName.value.trim()
  if (!name) return
  busy.value = true
  try {
    await accounts.createOrg(name)
    newOrgName.value = ''
    toast.add({ title: t('layout.accountTeam.org.created'), icon: 'i-lucide-check' })
  } catch (e) {
    notifyError(t('layout.accountTeam.errors.createOrg'), e)
  } finally {
    busy.value = false
  }
}

// ---- invitations ----------------------------------------------------------
const inviteEmail = ref('')
const inviteRoles = ref<AccountRole[]>(['developer'])

async function sendInvite() {
  if (!inviteEmail.value.trim()) return
  busy.value = true
  try {
    const acceptUrl = await accounts.invite(
      props.accountId,
      inviteEmail.value.trim(),
      inviteRoles.value.length ? inviteRoles.value : ['developer'],
    )
    inviteEmail.value = ''
    toast.add({
      title: t('layout.accountTeam.invite.created'),
      description: acceptUrl
        ? t('layout.accountTeam.invite.createdEmailed')
        : t('layout.accountTeam.invite.createdShareLink'),
      icon: 'i-lucide-mail-check',
    })
  } catch (e) {
    notifyError(t('layout.accountTeam.errors.sendInvite'), e)
  } finally {
    busy.value = false
  }
}

async function revoke(id: string) {
  try {
    await accounts.revokeInvite(props.accountId, id)
  } catch (e) {
    notifyError(t('layout.accountTeam.errors.revokeInvite'), e)
  }
}

// ---- email sender ---------------------------------------------------------
const emailProvider = ref<'sendgrid' | 'resend'>('resend')
const emailApiKey = ref('')
const emailFrom = ref('')

async function connectEmail() {
  if (!emailApiKey.value.trim() || !emailFrom.value.trim()) return
  busy.value = true
  try {
    await accounts.connectEmail(props.accountId, {
      provider: emailProvider.value,
      apiKey: emailApiKey.value.trim(),
      fromAddress: emailFrom.value.trim(),
    })
    emailApiKey.value = ''
    toast.add({ title: t('layout.accountTeam.email.connected'), icon: 'i-lucide-check' })
  } catch (e) {
    notifyError(t('layout.accountTeam.errors.connectEmail'), e)
  } finally {
    busy.value = false
  }
}

async function disconnectEmail() {
  busy.value = true
  try {
    await accounts.disconnectEmail(props.accountId)
  } catch (e) {
    notifyError(t('layout.accountTeam.errors.disconnectEmail'), e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-6 text-sm">
    <!-- personal-account CTA: members/roles/invitations need an organization -->
    <section v-if="!isOrg" class="rounded-md border border-slate-800 bg-slate-800/40 p-4">
      <h3 class="mb-1 font-semibold text-white">{{ t('layout.accountTeam.org.ctaTitle') }}</h3>
      <p class="mb-3 text-slate-400">
        {{ t('layout.accountTeam.org.ctaBody') }}
      </p>
      <form class="flex gap-2" @submit.prevent="createOrganization">
        <UInput
          v-model="newOrgName"
          :placeholder="t('layout.accountTeam.org.namePlaceholder')"
          class="flex-1"
        />
        <UButton type="submit" color="primary" :loading="busy" icon="i-lucide-plus">
          {{ t('layout.accountTeam.org.create') }}
        </UButton>
      </form>
    </section>

    <!-- members -->
    <section v-if="isOrg">
      <h3 class="mb-2 font-semibold text-white">{{ t('layout.accountTeam.members.title') }}</h3>
      <ul class="space-y-1">
        <li
          v-for="m in accounts.members"
          :key="m.userId"
          class="flex items-center justify-between rounded-md bg-slate-800/40 px-2 py-1"
        >
          <span class="truncate">{{ m.name || m.email || m.userId }}</span>
          <USelect
            v-if="isAdmin"
            :model-value="m.roles"
            multiple
            :items="ROLE_ITEMS"
            size="xs"
            class="w-44"
            @update:model-value="(r: AccountRole[]) => updateMemberRoles(m.userId, r)"
          />
          <span v-else class="text-xs uppercase tracking-wide text-slate-400">
            {{ m.roles.join(', ') }}
          </span>
        </li>
        <li v-if="accounts.members.length === 0" class="text-slate-500">
          {{ t('layout.accountTeam.members.empty') }}
        </li>
      </ul>
    </section>

    <!-- invitations -->
    <section v-if="isOrg">
      <h3 class="mb-2 font-semibold text-white">{{ t('layout.accountTeam.invite.title') }}</h3>
      <form class="flex gap-2" @submit.prevent="sendInvite">
        <UInput
          v-model="inviteEmail"
          type="email"
          :placeholder="t('layout.accountTeam.invite.emailPlaceholder')"
          class="flex-1"
        />
        <USelect v-model="inviteRoles" multiple :items="ROLE_ITEMS" class="w-44" />
        <UButton type="submit" color="primary" :loading="busy" icon="i-lucide-send">
          {{ t('layout.accountTeam.invite.submit') }}
        </UButton>
      </form>

      <ul v-if="accounts.invitations.length" class="mt-3 space-y-1">
        <li
          v-for="inv in accounts.invitations"
          :key="inv.id"
          class="flex items-center justify-between rounded-md bg-slate-800/40 px-2 py-1"
        >
          <span class="truncate">{{ inv.email }}</span>
          <span class="flex items-center gap-2 text-xs">
            <span class="uppercase tracking-wide text-slate-400">
              {{ invitationStatusLabel(inv.status) }}
            </span>
            <UButton
              v-if="inv.status === 'pending'"
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-x"
              :aria-label="t('layout.accountTeam.invite.revoke')"
              @click="revoke(inv.id)"
            />
          </span>
        </li>
      </ul>
    </section>

    <!-- email sender -->
    <section>
      <h3 class="mb-2 font-semibold text-white">{{ t('layout.accountTeam.email.title') }}</h3>
      <p v-if="!accounts.emailConfigured" class="text-slate-500">
        {{ t('layout.accountTeam.email.notEnabled') }}
      </p>
      <template v-else>
        <div
          v-if="accounts.emailConnection"
          class="flex items-center justify-between rounded-md bg-slate-800/40 px-2 py-1.5"
        >
          <i18n-t keypath="layout.accountTeam.email.connectedAs" tag="span" scope="global">
            <template #provider>
              <strong>{{ accounts.emailConnection.provider }}</strong>
            </template>
            <template #from>{{ accounts.emailConnection.fromAddress }}</template>
          </i18n-t>
          <UButton size="xs" color="error" variant="ghost" :loading="busy" @click="disconnectEmail">
            {{ t('layout.accountTeam.email.disconnect') }}
          </UButton>
        </div>
        <form v-else class="space-y-2" @submit.prevent="connectEmail">
          <USelect v-model="emailProvider" :items="EMAIL_PROVIDER_ITEMS" class="w-full" />
          <UInput
            v-model="emailFrom"
            type="email"
            :placeholder="t('layout.accountTeam.email.fromPlaceholder')"
            class="w-full"
          />
          <UInput
            v-model="emailApiKey"
            type="password"
            :placeholder="t('layout.accountTeam.email.apiKeyPlaceholder')"
            class="w-full"
          />
          <UButton type="submit" color="primary" :loading="busy">
            {{ t('layout.accountTeam.email.connect') }}
          </UButton>
        </form>
      </template>
    </section>

    <!-- account-wide provider API keys (admin-only): direct vendors + proxy gateways -->
    <section v-if="isAdmin" class="space-y-6">
      <h3 class="mb-2 font-semibold text-white">{{ t('layout.accountTeam.apiKeys.title') }}</h3>
      <ProvidersApiKeysSection :account-id="accountId" category="direct" />
      <div class="border-t border-slate-800 pt-6">
        <ProvidersApiKeysSection :account-id="accountId" category="proxy" />
      </div>
    </section>

    <!-- deployment integration secrets (admin-only): Slack OAuth app + web-search keys -->
    <section v-if="isAdmin">
      <AccountDeploymentSettings :account-id="accountId" />
    </section>
  </div>
</template>
