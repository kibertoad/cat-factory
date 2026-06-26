<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { AccountRole } from '~/types/domain'
import AccountDeploymentSettings from '~/components/layout/AccountDeploymentSettings.vue'

// Team settings for an org account: the member roster (with combinable admin /
// developer / product roles), pending email invitations, and the per-account
// transactional-email sender. Admin-only mutations are enforced by the backend; this
// surface degrades to a read-only view when the caller isn't an admin (actions 4xx).
const props = defineProps<{ accountId: string }>()

const accounts = useAccountsStore()
const toast = useToast()
const busy = ref(false)

const ROLE_ITEMS: { label: string; value: AccountRole }[] = [
  { label: 'Admin', value: 'admin' },
  { label: 'Developer', value: 'developer' },
  { label: 'Product', value: 'product' },
]

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
    notifyError('Could not update roles', e)
  }
}

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description:
      (e as { data?: { error?: { message?: string } } })?.data?.error?.message ??
      (e instanceof Error ? e.message : String(e)),
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
    notifyError('Could not load team settings', e)
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
    toast.add({ title: 'Organization created', icon: 'i-lucide-check' })
  } catch (e) {
    notifyError('Could not create organization', e)
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
      title: 'Invitation created',
      description: acceptUrl
        ? 'An email was sent (or copy the link from the list below).'
        : 'Share the accept link with your teammate.',
      icon: 'i-lucide-mail-check',
    })
  } catch (e) {
    notifyError('Could not send invitation', e)
  } finally {
    busy.value = false
  }
}

async function revoke(id: string) {
  try {
    await accounts.revokeInvite(props.accountId, id)
  } catch (e) {
    notifyError('Could not revoke invitation', e)
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
    toast.add({ title: 'Email sender connected', icon: 'i-lucide-check' })
  } catch (e) {
    notifyError('Could not connect email sender', e)
  } finally {
    busy.value = false
  }
}

async function disconnectEmail() {
  busy.value = true
  try {
    await accounts.disconnectEmail(props.accountId)
  } catch (e) {
    notifyError('Could not disconnect email sender', e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-6 text-sm">
    <!-- personal-account CTA: members/roles/invitations need an organization -->
    <section v-if="!isOrg" class="rounded-md border border-slate-800 bg-slate-800/40 p-4">
      <h3 class="mb-1 font-semibold text-white">Invite teammates &amp; manage roles</h3>
      <p class="mb-3 text-slate-400">
        Members, roles and invitations live on an organization. Create one to invite teammates and
        manage their roles — your personal boards stay as they are.
      </p>
      <form class="flex gap-2" @submit.prevent="createOrganization">
        <UInput v-model="newOrgName" placeholder="Acme Inc." class="flex-1" />
        <UButton type="submit" color="primary" :loading="busy" icon="i-lucide-plus">
          Create organization
        </UButton>
      </form>
    </section>

    <!-- members -->
    <section v-if="isOrg">
      <h3 class="mb-2 font-semibold text-white">Members</h3>
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
        <li v-if="accounts.members.length === 0" class="text-slate-500">No members yet.</li>
      </ul>
    </section>

    <!-- invitations -->
    <section v-if="isOrg">
      <h3 class="mb-2 font-semibold text-white">Invite a teammate</h3>
      <form class="flex gap-2" @submit.prevent="sendInvite">
        <UInput
          v-model="inviteEmail"
          type="email"
          placeholder="teammate@example.com"
          class="flex-1"
        />
        <USelect v-model="inviteRoles" multiple :items="ROLE_ITEMS" class="w-44" />
        <UButton type="submit" color="primary" :loading="busy" icon="i-lucide-send">Invite</UButton>
      </form>

      <ul v-if="accounts.invitations.length" class="mt-3 space-y-1">
        <li
          v-for="inv in accounts.invitations"
          :key="inv.id"
          class="flex items-center justify-between rounded-md bg-slate-800/40 px-2 py-1"
        >
          <span class="truncate">{{ inv.email }}</span>
          <span class="flex items-center gap-2 text-xs">
            <span class="uppercase tracking-wide text-slate-400">{{ inv.status }}</span>
            <UButton
              v-if="inv.status === 'pending'"
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-x"
              @click="revoke(inv.id)"
            />
          </span>
        </li>
      </ul>
    </section>

    <!-- email sender -->
    <section>
      <h3 class="mb-2 font-semibold text-white">Email sender</h3>
      <p v-if="!accounts.emailConfigured" class="text-slate-500">
        Email delivery is not enabled on this deployment. Invitations still produce a shareable
        accept link.
      </p>
      <template v-else>
        <div
          v-if="accounts.emailConnection"
          class="flex items-center justify-between rounded-md bg-slate-800/40 px-2 py-1.5"
        >
          <span>
            Connected via <strong>{{ accounts.emailConnection.provider }}</strong> as
            {{ accounts.emailConnection.fromAddress }}
          </span>
          <UButton size="xs" color="error" variant="ghost" :loading="busy" @click="disconnectEmail">
            Disconnect
          </UButton>
        </div>
        <form v-else class="space-y-2" @submit.prevent="connectEmail">
          <USelect
            v-model="emailProvider"
            :items="[
              { label: 'Resend', value: 'resend' },
              { label: 'SendGrid', value: 'sendgrid' },
            ]"
            class="w-full"
          />
          <UInput v-model="emailFrom" type="email" placeholder="From address" class="w-full" />
          <UInput
            v-model="emailApiKey"
            type="password"
            placeholder="Provider API key"
            class="w-full"
          />
          <UButton type="submit" color="primary" :loading="busy">Connect email sender</UButton>
        </form>
      </template>
    </section>

    <!-- account-wide provider API keys (admin-only): direct vendors + proxy gateways -->
    <section v-if="isAdmin" class="space-y-6">
      <h3 class="mb-2 font-semibold text-white">Account API keys</h3>
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
