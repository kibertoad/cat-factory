<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { CloudProvider } from '~/types/domain'

// Account + board switching. Picks the active account (personal / org) and the
// active board within it, and manages boards (new / rename / delete). The account
// row is shown only when accounts exist (auth on); in dev it falls back to a plain
// board switcher over the single unscoped context.
const accounts = useAccountsStore()
const workspace = useWorkspaceStore()
const toast = useToast()

const busy = ref(false)

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

// The cloud provider new services in the active account default to (a service may
// override it per-frame). `docker` is the local Docker/Podman backend.
const PROVIDERS: { value: CloudProvider; label: string }[] = [
  { value: 'cloudflare', label: 'Cloudflare' },
  { value: 'docker', label: 'Docker (local)' },
  { value: 'aws', label: 'AWS' },
  { value: 'gcp', label: 'GCP' },
  { value: 'azure', label: 'Azure' },
  { value: 'custom', label: 'Custom' },
]

async function setDefaultProvider(provider: CloudProvider) {
  const id = accounts.activeAccountId
  if (!id) return
  try {
    await accounts.setDefaultCloudProvider(id, provider)
  } catch (e) {
    notifyError('Could not update default provider', e)
  }
}

// ---- account + board menus -------------------------------------------------
const accountItems = computed<DropdownMenuItem[][]>(() => [
  accounts.accounts.map((a) => ({
    label: a.name,
    icon: a.type === 'org' ? 'i-lucide-users' : 'i-lucide-user',
    trailingIcon: a.id === accounts.activeAccountId ? 'i-lucide-check' : undefined,
    onSelect: () => void selectAccount(a.id),
  })),
  [
    { label: 'New organization…', icon: 'i-lucide-plus', onSelect: () => openPrompt('account') },
    // Team management (members + invitations + email sender) for org accounts.
    ...(accounts.activeAccount?.type === 'org'
      ? [{ label: 'Manage team…', icon: 'i-lucide-users', onSelect: () => openSettings() }]
      : []),
    // Admins can set the account-wide default provider new services inherit.
    ...(accounts.activeAccount?.roles?.includes('admin')
      ? [
          {
            label: 'Default cloud provider',
            icon: 'i-lucide-cloud',
            children: PROVIDERS.map((p) => ({
              label: p.label,
              trailingIcon:
                (accounts.activeAccount?.defaultCloudProvider ?? 'cloudflare') === p.value
                  ? 'i-lucide-check'
                  : undefined,
              onSelect: () => void setDefaultProvider(p.value),
            })),
          },
        ]
      : []),
  ],
])

const boardItems = computed<DropdownMenuItem[][]>(() => [
  workspace.accountWorkspaces.map((w) => ({
    label: w.name,
    icon: 'i-lucide-layout-dashboard',
    trailingIcon: w.id === workspace.workspaceId ? 'i-lucide-check' : undefined,
    onSelect: () => void switchBoard(w.id),
  })),
  [
    { label: 'New board…', icon: 'i-lucide-plus', onSelect: () => openPrompt('board') },
    { label: 'Rename board…', icon: 'i-lucide-pencil', onSelect: () => openPrompt('rename') },
    {
      label: 'Delete board',
      icon: 'i-lucide-trash-2',
      color: 'error' as const,
      onSelect: () => void removeBoard(),
    },
  ],
])

async function selectAccount(id: string) {
  if (id === accounts.activeAccountId) return
  busy.value = true
  try {
    await workspace.selectAccount(id)
  } catch (e) {
    notifyError('Could not switch account', e)
  } finally {
    busy.value = false
  }
}

async function switchBoard(id: string) {
  busy.value = true
  try {
    await workspace.switchTo(id)
  } catch (e) {
    notifyError('Could not open board', e)
  } finally {
    busy.value = false
  }
}

async function removeBoard() {
  const id = workspace.workspaceId
  if (!id) return
  busy.value = true
  try {
    await workspace.remove(id)
    toast.add({ title: 'Board deleted', icon: 'i-lucide-check' })
  } catch (e) {
    notifyError('Could not delete board', e)
  } finally {
    busy.value = false
  }
}

// ---- prompt modal (create account / create board / rename) -----------------
type PromptKind = 'account' | 'board' | 'rename'
const prompt = ref<PromptKind | null>(null)
const promptValue = ref('')
// Board create/rename also carries an optional description (Part C of onboarding).
const promptDescription = ref('')
const promptOpen = computed({
  get: () => prompt.value !== null,
  set: (v: boolean) => {
    if (!v) prompt.value = null
  },
})
const promptMeta: Record<PromptKind, { title: string; placeholder: string; cta: string }> = {
  account: { title: 'New organization', placeholder: 'Acme Inc.', cta: 'Create' },
  board: { title: 'New board', placeholder: 'Untitled board', cta: 'Create' },
  rename: { title: 'Board settings', placeholder: 'Board name', cta: 'Save' },
}
/** Whether the current prompt edits a board (so it shows the description field). */
const promptHasDescription = computed(() => prompt.value === 'board' || prompt.value === 'rename')

function openPrompt(kind: PromptKind) {
  prompt.value = kind
  promptValue.value = kind === 'rename' ? (workspace.activeWorkspace?.name ?? '') : ''
  promptDescription.value = kind === 'rename' ? (workspace.activeWorkspace?.description ?? '') : ''
}

async function submitPrompt() {
  const kind = prompt.value
  const name = promptValue.value.trim()
  const description = promptDescription.value.trim()
  if (!kind || (!name && kind !== 'board')) return
  busy.value = true
  try {
    if (kind === 'account') {
      await accounts.createOrg(name)
      // The new org starts empty — open (create) its first board.
      await workspace.selectAccount(accounts.activeAccountId!)
    } else if (kind === 'board') {
      await workspace.create(name || undefined, description || undefined)
    } else if (workspace.workspaceId) {
      await workspace.update(workspace.workspaceId, {
        name,
        description: description || null,
      })
    }
    prompt.value = null
  } catch (e) {
    notifyError('Action failed', e)
  } finally {
    busy.value = false
  }
}

// ---- account settings modal (members / invitations / email) ----------------
const settingsOpen = ref(false)
function openSettings() {
  settingsOpen.value = true
}
</script>

<template>
  <div class="space-y-1.5">
    <!-- account selector (only when accounts exist) -->
    <UDropdownMenu
      v-if="accounts.enabled"
      :items="accountItems"
      :content="{ align: 'start' }"
      class="w-full"
    >
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition hover:bg-slate-800/60"
        :disabled="busy"
      >
        <UIcon
          :name="accounts.activeAccount?.type === 'org' ? 'i-lucide-users' : 'i-lucide-user'"
          class="h-3.5 w-3.5 shrink-0 text-slate-400"
        />
        <span class="truncate text-[11px] font-medium uppercase tracking-wide text-slate-400">
          {{ accounts.activeAccount?.name ?? 'Account' }}
        </span>
        <UIcon
          name="i-lucide-chevrons-up-down"
          class="ml-auto h-3.5 w-3.5 shrink-0 text-slate-600"
        />
      </button>
    </UDropdownMenu>

    <!-- board selector -->
    <UDropdownMenu :items="boardItems" :content="{ align: 'start' }" class="w-full">
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-1.5 text-left transition hover:bg-slate-800/60"
        :disabled="busy"
      >
        <UIcon name="i-lucide-layout-dashboard" class="h-4 w-4 shrink-0 text-indigo-400" />
        <span class="truncate text-sm font-medium text-white">
          {{ workspace.activeWorkspace?.name ?? 'Board' }}
        </span>
        <UIcon name="i-lucide-chevron-down" class="ml-auto h-4 w-4 shrink-0 text-slate-500" />
      </button>
    </UDropdownMenu>

    <!-- create / rename prompt -->
    <UModal v-model:open="promptOpen" :title="prompt ? promptMeta[prompt].title : ''">
      <template #body>
        <form class="space-y-3" @submit.prevent="submitPrompt">
          <UFormField label="Name">
            <UInput
              v-model="promptValue"
              autofocus
              :placeholder="prompt ? promptMeta[prompt].placeholder : ''"
              class="w-full"
            />
          </UFormField>
          <UFormField v-if="promptHasDescription" label="Description" hint="Optional">
            <UTextarea
              v-model="promptDescription"
              :rows="3"
              placeholder="What is this board for?"
              class="w-full"
            />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" :disabled="busy" @click="prompt = null">
              Cancel
            </UButton>
            <UButton type="submit" color="primary" :loading="busy">
              {{ prompt ? promptMeta[prompt].cta : '' }}
            </UButton>
          </div>
        </form>
      </template>
    </UModal>

    <!-- account team settings: members, invitations, email sender -->
    <UModal v-model:open="settingsOpen" title="Team settings">
      <template #body>
        <AccountTeamSettings
          v-if="accounts.activeAccountId"
          :account-id="accounts.activeAccountId"
        />
      </template>
    </UModal>
  </div>
</template>
