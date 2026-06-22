<script setup lang="ts">
import { onMounted, ref } from 'vue'

// Team settings for an org account: the member roster, pending email invitations,
// and the per-account transactional-email sender (UI-onboarded, stored sealed in the
// DB). Owner-only mutations are enforced by the backend; this surface degrades to a
// read-only view when the caller isn't an owner (the actions just 4xx).
const props = defineProps<{ accountId: string }>()

const accounts = useAccountsStore()
const toast = useToast()
const busy = ref(false)

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

onMounted(async () => {
  try {
    await Promise.all([
      accounts.loadRoster(props.accountId),
      accounts.loadEmailConnection(props.accountId),
    ])
  } catch (e) {
    notifyError('Could not load team settings', e)
  }
})

// ---- invitations ----------------------------------------------------------
const inviteEmail = ref('')
const inviteRole = ref<'member' | 'owner'>('member')

async function sendInvite() {
  if (!inviteEmail.value.trim()) return
  busy.value = true
  try {
    const acceptUrl = await accounts.invite(props.accountId, inviteEmail.value.trim(), inviteRole.value)
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
    <!-- members -->
    <section>
      <h3 class="mb-2 font-semibold text-white">Members</h3>
      <ul class="space-y-1">
        <li
          v-for="m in accounts.members"
          :key="m.userId"
          class="flex items-center justify-between rounded-md bg-slate-800/40 px-2 py-1"
        >
          <span class="truncate">{{ m.name || m.email || m.userId }}</span>
          <span class="text-xs uppercase tracking-wide text-slate-400">{{ m.role }}</span>
        </li>
        <li v-if="accounts.members.length === 0" class="text-slate-500">No members yet.</li>
      </ul>
    </section>

    <!-- invitations -->
    <section>
      <h3 class="mb-2 font-semibold text-white">Invite a teammate</h3>
      <form class="flex gap-2" @submit.prevent="sendInvite">
        <UInput
          v-model="inviteEmail"
          type="email"
          placeholder="teammate@example.com"
          class="flex-1"
        />
        <USelect
          v-model="inviteRole"
          :items="[
            { label: 'Member', value: 'member' },
            { label: 'Owner', value: 'owner' },
          ]"
        />
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
        Email delivery is not enabled on this deployment. Invitations still produce a
        shareable accept link.
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
          <UInput v-model="emailApiKey" type="password" placeholder="Provider API key" class="w-full" />
          <UButton type="submit" color="primary" :loading="busy">Connect email sender</UButton>
        </form>
      </template>
    </section>
  </div>
</template>
