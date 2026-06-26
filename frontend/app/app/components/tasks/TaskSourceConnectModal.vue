<script setup lang="ts">
// Connect/manage a task source for the workspace. The form is rendered generically
// from the source's descriptor (credential fields), so the same modal serves Jira
// and any future credentialed tracker. A credentialless source (GitHub Issues)
// has no form — it rides the workspace's installed GitHub App — so the modal just
// offers the on/off toggle. Secret credentials are write-only: the backend never
// returns them, so on reload we show "Connected" with empty fields.
//
// The on/off toggle is the per-workspace switch (persisted in task_source_settings):
// a workspace can offer GitHub repos without offering their issues, and can park a
// connected Jira without disconnecting it. The toggle only applies once a source is
// available (Jira connected / the GitHub App installed) — there is nothing to offer
// before that.
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const ui = useUiStore()
const tasks = useTasksStore()
const toast = useToast()

const source = computed(() => ui.taskConnect?.source ?? null)
const descriptor = computed(() => (source.value ? tasks.descriptorFor(source.value) : undefined))
const connection = computed(() => (source.value ? tasks.connectionFor(source.value) : undefined))
const connected = computed(() => connection.value !== undefined)
// A credentialless source (GitHub Issues) reuses the installed GitHub App: no form.
const credentialless = computed(() => (descriptor.value?.credentialFields.length ?? 0) === 0)
// Usable right now: a credentialed source is connected; GitHub Issues' App is installed.
const available = computed(() => descriptor.value?.available ?? false)

const open = computed({
  get: () => ui.taskConnect !== null,
  set: (v: boolean) => {
    if (!v) ui.closeTaskConnect()
  },
})

/** One value per credential field, reset whenever the modal (re)opens. */
const values = ref<Record<string, string>>({})
const saving = ref(false)
const togglingEnabled = ref(false)

watch(open, (isOpen) => {
  if (isOpen) values.value = {}
})

const canSubmit = computed(() => {
  const fields = descriptor.value?.credentialFields ?? []
  return fields.every((f) => (values.value[f.key] ?? '').trim())
})

async function submit() {
  if (!canSubmit.value || !source.value || credentialless.value) return
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
    // Re-probe so `available`/`enabled` reflect the new connection.
    await tasks.probe()
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
  await tasks.probe()
  toast.add({
    title: `${descriptor.value?.label ?? 'Source'} disconnected`,
    icon: 'i-lucide-unplug',
  })
  ui.closeTaskConnect()
}

async function toggleEnabled(enabled: boolean) {
  if (!source.value) return
  togglingEnabled.value = true
  try {
    await tasks.setEnabled(source.value, enabled)
  } catch (e) {
    toast.add({
      title: 'Could not update',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    togglingEnabled.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="descriptor?.label ?? 'Task source'">
    <template #title>
      <IntegrationBackTitle
        :title="descriptor?.label ?? 'Task source'"
        @back="((open = false), ui.openIntegrations())"
      />
    </template>
    <template #body>
      <div v-if="descriptor" class="space-y-4">
        <p class="text-sm text-slate-400">
          {{ descriptor.label }} lets you import issues and attach them to tasks as agent context.
        </p>

        <!-- Credentialless source (GitHub Issues): no form, just the on/off toggle. -->
        <template v-if="credentialless">
          <p class="text-[11px] text-slate-500">
            This source uses the GitHub App already installed on your workspace — there are no
            credentials to enter.
          </p>
          <p v-if="!available" class="text-[11px] text-amber-400">
            Install the workspace's GitHub App (connect GitHub repos) to offer
            {{ descriptor.label }}.
          </p>
        </template>

        <!-- Credentialed source (Jira): the connect form, shown until connected. -->
        <div v-else-if="!connected" class="space-y-3">
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
        <p v-else class="text-[11px] text-slate-500">
          Connected{{ connection?.label ? ` to ${connection.label}` : '' }}.
        </p>

        <!-- The per-workspace on/off toggle, available once the source is usable. -->
        <div
          v-if="available"
          class="flex items-center justify-between gap-2 rounded-md border border-slate-800 px-3 py-2"
        >
          <div class="text-sm">
            <div class="font-medium text-slate-200">Offer to this workspace</div>
            <div class="text-[11px] text-slate-500">
              When off, {{ descriptor.label }} is hidden from import and linking.
            </div>
          </div>
          <USwitch
            :model-value="descriptor.enabled"
            :loading="togglingEnabled"
            @update:model-value="toggleEnabled"
          />
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
            v-if="!credentialless"
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
