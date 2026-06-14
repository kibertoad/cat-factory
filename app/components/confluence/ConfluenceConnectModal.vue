<script setup lang="ts">
// Connect (or disconnect) the workspace to a Confluence Cloud site. The API
// token is write-only — it is never returned by the backend, so on reload we
// only show "Connected as <email>" with an empty token field.
const ui = useUiStore()
const confluence = useConfluenceStore()
const toast = useToast()

const open = computed({
  get: () => ui.confluenceConnectOpen,
  set: (v: boolean) => {
    if (!v) ui.closeConfluenceConnect()
  },
})

const baseUrl = ref('')
const accountEmail = ref('')
const apiToken = ref('')
const saving = ref(false)

watch(open, (isOpen) => {
  if (isOpen) {
    baseUrl.value = confluence.connection?.baseUrl ?? ''
    accountEmail.value = confluence.connection?.accountEmail ?? ''
    apiToken.value = ''
  }
})

const canSubmit = computed(
  () => baseUrl.value.trim() && accountEmail.value.trim() && apiToken.value.trim(),
)

async function submit() {
  if (!canSubmit.value) return
  saving.value = true
  try {
    await confluence.connect({
      baseUrl: baseUrl.value.trim(),
      accountEmail: accountEmail.value.trim(),
      apiToken: apiToken.value,
    })
    toast.add({ title: 'Confluence connected', icon: 'i-lucide-check', color: 'success' })
    ui.closeConfluenceConnect()
  } catch (e) {
    toast.add({
      title: 'Could not connect',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}

async function disconnect() {
  await confluence.disconnect()
  toast.add({ title: 'Confluence disconnected', icon: 'i-lucide-unplug' })
  ui.closeConfluenceConnect()
}
</script>

<template>
  <UModal v-model:open="open" title="Confluence">
    <template #body>
      <div class="space-y-4">
        <p class="text-sm text-slate-400">
          Connect a Confluence Cloud site to import requirements, RFCs and PRDs, then spawn board
          structure or attach them to tasks as agent context.
        </p>

        <div class="space-y-3">
          <UFormField label="Site URL" help="e.g. https://your-team.atlassian.net">
            <UInput
              v-model="baseUrl"
              placeholder="https://your-team.atlassian.net"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Account email">
            <UInput v-model="accountEmail" placeholder="you@company.com" class="w-full" />
          </UFormField>
          <UFormField
            label="API token"
            help="Create one at id.atlassian.com → Security → API tokens"
          >
            <UInput
              v-model="apiToken"
              type="password"
              placeholder="Paste a Confluence API token"
              class="w-full"
            />
          </UFormField>
        </div>

        <div class="flex items-center justify-between gap-2 pt-1">
          <UButton
            v-if="confluence.connected"
            color="error"
            variant="ghost"
            icon="i-lucide-unplug"
            @click="disconnect"
          >
            Disconnect
          </UButton>
          <div v-else />
          <UButton
            color="primary"
            icon="i-lucide-plug"
            :loading="saving"
            :disabled="!canSubmit"
            @click="submit"
          >
            {{ confluence.connected ? 'Update connection' : 'Connect' }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
