<script setup lang="ts">
// The observability connection — the post-release-health gate reads a pluggable
// observability provider (Datadog today). This panel owns ONLY the per-workspace
// connection (provider + credentials, write-only). The per-service monitor/SLO mapping
// lives in the service inspector (ServiceReleaseHealthConfig), so there is no manual
// block-id entry here. Opened from the Integrations hub.
import { computed, reactive, ref, watch } from 'vue'
import type { ObservabilityProviderKind } from '~/types/releaseHealth'

const ui = useUiStore()
const store = useReleaseHealthStore()
const toast = useToast()

const open = computed({
  get: () => ui.observabilityConnectionOpen,
  set: (v: boolean) => (v ? ui.openObservabilityConnection() : ui.closeObservabilityConnection()),
})

// The providers a user can connect. Datadog only today; the picker is ready for more.
const PROVIDERS: { value: ObservabilityProviderKind; label: string }[] = [
  { value: 'datadog', label: 'Datadog' },
]

const provider = ref<ObservabilityProviderKind>('datadog')
const datadog = reactive({ site: 'datadoghq.com', apiKey: '', appKey: '' })
const busy = ref(false)

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

watch(open, async (isOpen) => {
  if (!isOpen) return
  try {
    await store.ensureLoaded()
    if (store.connection.provider) provider.value = store.connection.provider
    const site = store.connection.summary?.site
    if (site) datadog.site = site
  } catch (e) {
    notifyError('Could not load observability settings', e)
  }
})

async function saveConnection() {
  busy.value = true
  try {
    await store.saveConnection({
      provider: provider.value,
      credentials: { site: datadog.site, apiKey: datadog.apiKey, appKey: datadog.appKey },
    })
    datadog.apiKey = ''
    datadog.appKey = ''
    toast.add({ title: 'Observability connected', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError('Could not save the connection', e)
  } finally {
    busy.value = false
  }
}

async function disconnect() {
  busy.value = true
  try {
    await store.removeConnection()
  } catch (e) {
    notifyError('Could not disconnect', e)
  } finally {
    busy.value = false
  }
}

const connectedLabel = computed(() => {
  if (!store.connection.connected) return 'Not connected'
  const site = store.connection.summary?.site
  return site ? `Connected (${site})` : 'Connected'
})
</script>

<template>
  <UModal v-model:open="open" title="Post-release health" :ui="{ content: 'max-w-lg' }">
    <template #body>
      <div class="space-y-4">
        <p class="text-sm text-slate-400">
          After a release ships, the <code>post-release-health</code> gate watches the configured
          observability monitors/SLOs. On a regression it spawns an on-call agent to investigate (a
          human decides whether to revert). Map which monitors/SLOs a service watches from that
          service's inspector.
        </p>

        <section class="space-y-3 rounded-lg border border-slate-700 p-3">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold">Connection</h3>
            <UBadge :color="store.connection.connected ? 'success' : 'neutral'" variant="soft">
              {{ connectedLabel }}
            </UBadge>
          </div>

          <UFormField label="Provider">
            <USelect v-model="provider" :items="PROVIDERS" value-key="value" class="w-full" />
          </UFormField>

          <template v-if="provider === 'datadog'">
            <UFormField label="Datadog site">
              <UInput v-model="datadog.site" placeholder="datadoghq.com" class="w-full" />
            </UFormField>
            <UFormField label="API key">
              <UInput
                v-model="datadog.apiKey"
                type="password"
                placeholder="DD-API-KEY"
                class="w-full"
              />
            </UFormField>
            <UFormField label="Application key">
              <UInput
                v-model="datadog.appKey"
                type="password"
                placeholder="DD-APPLICATION-KEY"
                class="w-full"
              />
            </UFormField>
          </template>

          <div class="flex gap-2">
            <UButton
              :loading="busy"
              :disabled="!datadog.apiKey || !datadog.appKey"
              @click="saveConnection"
            >
              Save connection
            </UButton>
            <UButton
              v-if="store.connection.connected"
              color="error"
              variant="soft"
              :loading="busy"
              @click="disconnect"
            >
              Disconnect
            </UButton>
          </div>
        </section>
      </div>
    </template>
  </UModal>
</template>
