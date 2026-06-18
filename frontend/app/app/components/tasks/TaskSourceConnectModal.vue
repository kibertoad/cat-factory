<script setup lang="ts">
// Connect (or disconnect) the workspace to a task source. The form is rendered
// generically from the source's descriptor (credential fields), so the same
// modal serves Jira and any future tracker. Secret credentials are write-only —
// the backend never returns them, so on reload we show "Connected" with empty
// fields.
const ui = useUiStore()
const tasks = useTasksStore()
const toast = useToast()

const source = computed(() => ui.taskConnect?.source ?? null)
const descriptor = computed(() => (source.value ? tasks.descriptorFor(source.value) : undefined))
const connection = computed(() => (source.value ? tasks.connectionFor(source.value) : undefined))
const connected = computed(() => connection.value !== undefined)

const open = computed({
  get: () => ui.taskConnect !== null,
  set: (v: boolean) => {
    if (!v) ui.closeTaskConnect()
  },
})

/** One value per credential field, reset whenever the modal (re)opens. */
const values = ref<Record<string, string>>({})
const saving = ref(false)

watch(open, (isOpen) => {
  if (isOpen) values.value = {}
})

// A source with no credential fields (e.g. GitHub, which reuses the workspace's
// installed GitHub App) connects with an empty bag — there is nothing to fill in,
// so the button is enabled as long as it isn't already connected.
const credentialless = computed(() => (descriptor.value?.credentialFields.length ?? 0) === 0)

const canSubmit = computed(() => {
  const fields = descriptor.value?.credentialFields ?? []
  if (credentialless.value) return !connected.value
  return fields.every((f) => (values.value[f.key] ?? '').trim())
})

async function submit() {
  if (!canSubmit.value || !source.value) return
  const credentials: Record<string, string> = {}
  for (const f of descriptor.value!.credentialFields) {
    credentials[f.key] = values.value[f.key]!.trim()
  }
  saving.value = true
  try {
    await tasks.connect(source.value, credentials)
    toast.add({
      title: `${descriptor.value!.label} connected`,
      icon: 'i-lucide-check',
      color: 'success',
    })
    ui.closeTaskConnect()
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
  if (!source.value) return
  await tasks.disconnect(source.value)
  toast.add({
    title: `${descriptor.value?.label ?? 'Source'} disconnected`,
    icon: 'i-lucide-unplug',
  })
  ui.closeTaskConnect()
}
</script>

<template>
  <UModal v-model:open="open" :title="descriptor?.label ?? 'Connect source'">
    <template #body>
      <div v-if="descriptor" class="space-y-4">
        <p class="text-sm text-slate-400">
          Connect {{ descriptor.label }} to import issues and attach them to tasks as agent context.
        </p>

        <p v-if="credentialless" class="text-[11px] text-slate-500">
          This source uses the GitHub App already installed on your workspace — there are no
          credentials to enter. Connecting just enables linking its issues to tasks.
        </p>

        <div v-else class="space-y-3">
          <UFormField
            v-for="field in descriptor.credentialFields"
            :key="field.key"
            :label="field.label"
            :help="field.help"
          >
            <UInput
              v-model="values[field.key]"
              :type="field.secret ? 'password' : 'text'"
              :placeholder="field.placeholder"
              class="w-full"
            />
          </UFormField>
        </div>

        <div class="flex items-center justify-between gap-2 pt-1">
          <UButton
            v-if="connected"
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
            {{ connected ? 'Update connection' : 'Connect' }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
