<script setup lang="ts">
// Discover-and-link surface for the workspace's GitHub App installation. Lists
// the installations the App is already on (via the app JWT) so the user can bind
// one with a single click — no installation-id typing — falling back to the
// install redirect and a manual-id entry. Self-loads its list on mount; on a
// successful connect the github store flips `connected`, which the host surfaces
// react to. Shared by the GitHub panel and the bootstrap modal so the connect
// flow lives in one place.
const github = useGitHubStore()
const toast = useToast()

const installing = ref(false)
const installationId = ref('')
const connecting = ref(false)
// Track which installation row is mid-connect so only its button spins.
const connectingId = ref<number | null>(null)

onMounted(() => {
  void refreshInstallations()
})

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

async function refreshInstallations() {
  try {
    await github.loadInstallations()
  } catch (e) {
    // A 503 (integration off) is handled by the host; surface anything else.
    notifyError('Could not list GitHub installations', e)
  }
}

async function install() {
  installing.value = true
  try {
    window.location.href = await github.getInstallUrl()
  } catch (e) {
    notifyError('Could not start the GitHub App install', e)
    installing.value = false
  }
}

async function connect(id: number, onDone?: () => void) {
  connecting.value = true
  connectingId.value = id
  try {
    await github.connect(id)
    onDone?.()
    toast.add({ title: 'GitHub connected', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError('Could not connect', e)
  } finally {
    connecting.value = false
    connectingId.value = null
  }
}

async function connectManually() {
  const id = Number(installationId.value.trim())
  if (!Number.isInteger(id) || id <= 0) return
  await connect(id, () => {
    installationId.value = ''
  })
}
</script>

<template>
  <div class="space-y-3">
    <!-- discovered installations: pick one the App is already on -->
    <section class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium uppercase tracking-wide text-slate-500">
          Your installations
        </span>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-refresh-cw"
          :loading="github.loadingInstallations"
          @click="refreshInstallations"
        >
          Refresh
        </UButton>
      </div>

      <div
        v-if="github.loadingInstallations && !github.installations.length"
        class="flex items-center gap-2 py-3 text-sm text-slate-400"
      >
        <UIcon name="i-lucide-loader" class="h-4 w-4 animate-spin" /> Looking for installations…
      </div>

      <p
        v-else-if="!github.installations.length"
        class="rounded-md border border-dashed border-slate-800 px-3 py-3 text-sm text-slate-400"
      >
        No installations found for the App yet. Install it below, or connect by ID.
      </p>

      <div
        v-for="inst in github.installations"
        :key="inst.installationId"
        class="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2"
      >
        <div class="flex min-w-0 items-center gap-2">
          <UAvatar
            v-if="inst.accountAvatarUrl"
            :src="inst.accountAvatarUrl"
            size="2xs"
            :alt="inst.accountLogin"
          />
          <UIcon v-else name="i-lucide-github" class="h-4 w-4 text-slate-400" />
          <div class="min-w-0">
            <div class="truncate text-sm text-slate-200">{{ inst.accountLogin }}</div>
            <div class="text-[11px] text-slate-500">
              {{ inst.targetType }} · installation {{ inst.installationId }}
            </div>
          </div>
        </div>
        <UBadge
          v-if="inst.connected === 'this'"
          color="success"
          variant="subtle"
          size="sm"
          title="Already linked to this workspace"
        >
          linked
        </UBadge>
        <UBadge
          v-else-if="inst.connected === 'other'"
          color="neutral"
          variant="subtle"
          size="sm"
          title="Already connected to another workspace"
        >
          in use
        </UBadge>
        <UButton
          v-else
          size="xs"
          color="primary"
          variant="subtle"
          icon="i-lucide-plug"
          :loading="connectingId === inst.installationId"
          :disabled="connecting"
          @click="connect(inst.installationId)"
        >
          Connect
        </UButton>
      </div>
    </section>

    <USeparator label="or" />
    <UButton color="primary" icon="i-lucide-github" :loading="installing" @click="install">
      Install GitHub App
    </UButton>

    <USeparator label="or connect by ID" />
    <div class="flex items-end gap-2">
      <UFormField label="Installation ID" class="flex-1">
        <UInput v-model="installationId" type="number" placeholder="12345678" class="w-full" />
      </UFormField>
      <UButton
        color="neutral"
        variant="subtle"
        icon="i-lucide-plug"
        :loading="connecting && connectingId === null"
        :disabled="!installationId.trim()"
        @click="connectManually"
      >
        Connect
      </UButton>
    </div>
  </div>
</template>
