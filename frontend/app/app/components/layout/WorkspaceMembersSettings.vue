<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { apiErrorEnvelope } from '~/composables/api/errors'
import type { WorkspaceAccessMode, WorkspaceRole } from '~/types/domain'

// Workspace-membership management (workspace-rbac initiative, slice 9). The tier BELOW
// account tenancy: an account admin restricts a board to an explicit member list (with
// per-member workspace roles), while an unrestricted (`account`) board keeps the legacy
// "every account member sees it" behaviour. Every mutation here requires `members.manage`
// server-side, so the hosting Members tab only renders for a workspace admin.
//
// The add picker is sourced from the OWNING account's roster — a contractor joins the
// account first (the account invitation flow), then gets scoped to a board here.
const props = defineProps<{ workspaceId: string }>()

const workspace = useWorkspaceStore()
const members = useWorkspaceMembersStore()
const accounts = useAccountsStore()
const auth = useAuthStore()
const toast = useToast()
const { t } = useI18n()
const { confirmAction, toastDone } = useConfirmAction()

const busy = ref(false)

const ROLE_ITEMS = computed<{ label: string; value: WorkspaceRole }[]>(() => [
  { label: t('layout.workspaceMembers.roles.admin'), value: 'admin' },
  { label: t('layout.workspaceMembers.roles.member'), value: 'member' },
  { label: t('layout.workspaceMembers.roles.viewer'), value: 'viewer' },
])

/** The active board's row (carries `accountId` + `accessMode`). */
const board = computed(() => workspace.workspaces.find((w) => w.id === props.workspaceId) ?? null)
/** The owning account id — the source of the add-member picker roster. */
const accountId = computed(() => board.value?.accountId ?? null)
/** Whether the board is limited to its explicit roster (vs every account member). */
const restricted = computed(() => (board.value?.accessMode ?? 'account') === 'restricted')

/**
 * Account members not already on the board — the add picker's options. The service
 * rejects a non-account-member, so the picker never offers one; already-scoped members
 * are filtered out so the list only offers genuine additions.
 */
const candidates = computed(() => {
  const existing = new Set(members.members.map((m) => m.userId))
  return accounts.members
    .filter((m) => !existing.has(m.userId))
    .map((m) => ({ label: m.name || m.email || m.userId, value: m.userId }))
})

const addUserId = ref<string | undefined>(undefined)
const addRole = ref<WorkspaceRole>('member')

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: apiErrorEnvelope(e)?.message ?? (e instanceof Error ? e.message : String(e)),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

async function loadAll(workspaceId: string) {
  try {
    const jobs: Promise<unknown>[] = [members.load(workspaceId)]
    // The picker needs the owning account's roster; a legacy board with no account (the
    // service auto-heals it on the first write) simply shows no picker candidates.
    if (accountId.value) jobs.push(accounts.loadRoster(accountId.value))
    await Promise.all(jobs)
  } catch (e) {
    notifyError(t('layout.workspaceMembers.errors.load'), e)
  }
}

onMounted(() => void loadAll(props.workspaceId))
watch(
  () => props.workspaceId,
  (id) => {
    if (id) void loadAll(id)
  },
)

async function setAccessMode(next: boolean) {
  const mode: WorkspaceAccessMode = next ? 'restricted' : 'account'
  busy.value = true
  try {
    await members.setAccessMode(props.workspaceId, mode)
  } catch (e) {
    notifyError(t('layout.workspaceMembers.errors.accessMode'), e)
  } finally {
    busy.value = false
  }
}

async function updateRole(userId: string, role: WorkspaceRole) {
  try {
    await members.setRole(props.workspaceId, userId, role)
  } catch (e) {
    notifyError(t('layout.workspaceMembers.errors.setRole'), e)
  }
}

async function addMember() {
  const userId = addUserId.value
  if (!userId) return
  busy.value = true
  try {
    await members.add(props.workspaceId, userId, addRole.value)
    addUserId.value = undefined
    addRole.value = 'member'
    toast.add({ title: t('layout.workspaceMembers.add.added'), icon: 'i-lucide-user-plus' })
  } catch (e) {
    notifyError(t('layout.workspaceMembers.errors.add'), e)
  } finally {
    busy.value = false
  }
}

async function removeMember(userId: string, name: string) {
  if (!(await confirmAction('remove', name))) return
  try {
    await members.remove(props.workspaceId, userId)
    toastDone('remove', name)
  } catch (e) {
    notifyError(t('layout.workspaceMembers.errors.remove'), e)
  }
}

/** Label a member by their display details; badges the signed-in caller as "you". */
function memberLabel(userId: string, name?: string | null, email?: string | null): string {
  const base = name || email || userId
  return userId === auth.user?.id ? t('layout.workspaceMembers.you', { name: base }) : base
}
</script>

<template>
  <div class="space-y-6 text-sm" data-testid="workspace-members-settings">
    <!-- access mode -->
    <section class="rounded-md border border-slate-800 bg-slate-800/40 p-4">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h3 class="mb-1 font-semibold text-white">
            {{ t('layout.workspaceMembers.accessMode.title') }}
          </h3>
          <p class="text-slate-400">
            {{
              restricted
                ? t('layout.workspaceMembers.accessMode.restrictedHint')
                : t('layout.workspaceMembers.accessMode.accountHint')
            }}
          </p>
        </div>
        <label class="flex shrink-0 items-center gap-2">
          <USwitch
            :model-value="restricted"
            :disabled="busy"
            size="sm"
            data-testid="workspace-restrict-toggle"
            @update:model-value="setAccessMode"
          />
          <span class="text-xs text-slate-300">
            {{ t('layout.workspaceMembers.accessMode.restrictToggle') }}
          </span>
        </label>
      </div>
    </section>

    <!-- roster -->
    <section>
      <h3 class="mb-2 font-semibold text-white">{{ t('layout.workspaceMembers.roster.title') }}</h3>
      <ul class="space-y-1">
        <li
          v-for="m in members.members"
          :key="m.userId"
          class="flex items-center justify-between gap-2 rounded-md bg-slate-800/40 px-2 py-1"
        >
          <span class="truncate">{{ memberLabel(m.userId, m.name, m.email) }}</span>
          <span class="flex shrink-0 items-center gap-2">
            <USelect
              :model-value="m.role"
              :items="ROLE_ITEMS"
              value-key="value"
              size="xs"
              class="w-32"
              @update:model-value="(r: WorkspaceRole) => updateRole(m.userId, r)"
            />
            <UButton
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-user-minus"
              :aria-label="t('layout.workspaceMembers.roster.remove')"
              @click="removeMember(m.userId, memberLabel(m.userId, m.name, m.email))"
            />
          </span>
        </li>
        <li v-if="members.members.length === 0" class="text-slate-500">
          {{ t('layout.workspaceMembers.roster.empty') }}
        </li>
      </ul>
    </section>

    <!-- add member -->
    <section>
      <h3 class="mb-2 font-semibold text-white">{{ t('layout.workspaceMembers.add.title') }}</h3>
      <p v-if="!accountId" class="text-slate-500">
        {{ t('layout.workspaceMembers.add.noAccount') }}
      </p>
      <template v-else>
        <form class="flex gap-2" @submit.prevent="addMember">
          <USelect
            v-model="addUserId"
            :items="candidates"
            value-key="value"
            :placeholder="t('layout.workspaceMembers.add.selectMember')"
            :disabled="candidates.length === 0"
            class="flex-1"
          />
          <USelect v-model="addRole" :items="ROLE_ITEMS" value-key="value" class="w-32" />
          <UButton
            type="submit"
            color="primary"
            icon="i-lucide-user-plus"
            :loading="busy"
            :disabled="!addUserId"
          >
            {{ t('layout.workspaceMembers.add.submit') }}
          </UButton>
        </form>
        <p v-if="candidates.length === 0" class="mt-2 text-slate-500">
          {{ t('layout.workspaceMembers.add.allAdded') }}
        </p>
      </template>
    </section>
  </div>
</template>
