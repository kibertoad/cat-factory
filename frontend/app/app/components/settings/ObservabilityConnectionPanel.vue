<script setup lang="ts">
// The observability connection — the post-release-health gate reads a pluggable
// observability provider (Datadog today). This panel owns ONLY the per-workspace
// connection (provider + credentials, write-only). The per-service monitor/SLO mapping
// lives in the service inspector (ServiceReleaseHealthConfig), so there is no manual
// block-id entry here. Opened from the Integrations hub.
import { computed, reactive, ref, watch } from 'vue'
import type { ObservabilityProviderKind } from '~/types/releaseHealth'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const { t } = useI18n()
const ui = useUiStore()
const store = useReleaseHealthStore()
const toast = useToast()

const open = computed({
  get: () => ui.observabilityConnectionOpen,
  set: (v: boolean) => (v ? ui.openObservabilityConnection() : ui.closeObservabilityConnection()),
})
const back = useIntegrationBack(open)

// The providers a user can connect. Datadog only today; the picker is ready for more.
const PROVIDERS: { value: ObservabilityProviderKind; label: string }[] = [
  { value: 'datadog', label: 'Datadog' },
]

const provider = ref<ObservabilityProviderKind>('datadog')
const datadog = reactive({ site: 'datadoghq.com', apiKey: '', appKey: '' })
const busy = ref(false)

// Incident enrichment (PagerDuty + incident.io) — write-only secrets; blank leaves the
// stored value unchanged. Paired with observability since it acts on the same regression.
const pagerDuty = reactive({ apiToken: '', fromEmail: '' })
const incidentIo = reactive({ apiKey: '' })
const incidentBusy = ref(false)

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

watch(
  open,
  async (isOpen) => {
    if (!isOpen) return
    try {
      await store.ensureLoaded()
      if (store.connection.provider) provider.value = store.connection.provider
      const site = store.connection.summary?.site
      if (site) datadog.site = site
      await store.loadIncident()
    } catch (e) {
      notifyError(t('settings.observabilityConnection.toast.loadFailed'), e)
    }
  },
  { immediate: true },
)

async function saveIncident() {
  incidentBusy.value = true
  try {
    const input: Parameters<typeof store.saveIncident>[0] = {}
    if (pagerDuty.apiToken.trim() && pagerDuty.fromEmail.trim()) {
      input.pagerDuty = {
        apiToken: pagerDuty.apiToken.trim(),
        fromEmail: pagerDuty.fromEmail.trim(),
      }
    }
    if (incidentIo.apiKey.trim()) input.incidentIo = { apiKey: incidentIo.apiKey.trim() }
    if (!input.pagerDuty && !input.incidentIo) {
      toast.add({
        title: t('settings.observabilityConnection.toast.incidentCredsRequired'),
        color: 'error',
      })
      return
    }
    await store.saveIncident(input)
    pagerDuty.apiToken = ''
    pagerDuty.fromEmail = ''
    incidentIo.apiKey = ''
    toast.add({
      title: t('settings.observabilityConnection.toast.incidentSaved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('settings.observabilityConnection.toast.incidentSaveFailed'), e)
  } finally {
    incidentBusy.value = false
  }
}

async function disconnectIncident() {
  incidentBusy.value = true
  try {
    await store.removeIncident()
  } catch (e) {
    notifyError(t('settings.observabilityConnection.toast.incidentDisconnectFailed'), e)
  } finally {
    incidentBusy.value = false
  }
}

async function saveConnection() {
  busy.value = true
  try {
    await store.saveConnection({
      provider: provider.value,
      credentials: { site: datadog.site, apiKey: datadog.apiKey, appKey: datadog.appKey },
    })
    datadog.apiKey = ''
    datadog.appKey = ''
    toast.add({
      title: t('settings.observabilityConnection.toast.connected'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('settings.observabilityConnection.toast.connectFailed'), e)
  } finally {
    busy.value = false
  }
}

async function disconnect() {
  busy.value = true
  try {
    await store.removeConnection()
  } catch (e) {
    notifyError(t('settings.observabilityConnection.toast.disconnectFailed'), e)
  } finally {
    busy.value = false
  }
}

const connectedLabel = computed(() => {
  if (!store.connection.connected) return t('settings.observabilityConnection.status.notConnected')
  const site = store.connection.summary?.site
  return site
    ? t('settings.observabilityConnection.status.connectedWithSite', { site })
    : t('settings.observabilityConnection.status.connected')
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('settings.observabilityConnection.title')"
    :ui="{ content: 'max-w-lg' }"
  >
    <template #title>
      <IntegrationBackTitle :title="t('settings.observabilityConnection.title')" @back="back" />
    </template>
    <template #body>
      <div class="space-y-4">
        <i18n-t
          keypath="settings.observabilityConnection.intro"
          tag="p"
          class="text-sm text-slate-400"
          scope="global"
        >
          <template #gate>
            <code>post-release-health</code>
          </template>
        </i18n-t>

        <section class="space-y-3 rounded-lg border border-slate-700 p-3">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold">
              {{ t('settings.observabilityConnection.connection.heading') }}
            </h3>
            <UBadge :color="store.connection.connected ? 'success' : 'neutral'" variant="soft">
              {{ connectedLabel }}
            </UBadge>
          </div>

          <UFormField :label="t('settings.observabilityConnection.connection.provider')">
            <USelect v-model="provider" :items="PROVIDERS" value-key="value" class="w-full" />
          </UFormField>

          <template v-if="provider === 'datadog'">
            <UFormField :label="t('settings.observabilityConnection.datadog.site')">
              <UInput v-model="datadog.site" placeholder="datadoghq.com" class="w-full" />
            </UFormField>
            <UFormField :label="t('settings.observabilityConnection.datadog.apiKey')">
              <UInput
                v-model="datadog.apiKey"
                type="password"
                placeholder="DD-API-KEY"
                class="w-full"
              />
            </UFormField>
            <UFormField :label="t('settings.observabilityConnection.datadog.appKey')">
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
              {{ t('settings.observabilityConnection.saveConnection') }}
            </UButton>
            <UButton
              v-if="store.connection.connected"
              color="error"
              variant="soft"
              :loading="busy"
              @click="disconnect"
            >
              {{ t('settings.observabilityConnection.disconnect') }}
            </UButton>
          </div>
        </section>

        <!-- Incident enrichment (optional): annotate an incident PagerDuty / incident.io
             already opened from the same monitors/SLOs. -->
        <section
          v-if="store.incidentAvailable !== false"
          class="space-y-3 rounded-lg border border-slate-700 p-3"
        >
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold">
              {{ t('settings.observabilityConnection.incident.heading') }}
            </h3>
            <UBadge :color="store.incident.connected ? 'success' : 'neutral'" variant="soft">
              {{
                store.incident.connected
                  ? t('settings.observabilityConnection.incident.configured')
                  : t('settings.observabilityConnection.incident.notSet')
              }}
            </UBadge>
          </div>
          <p class="text-[11px] text-slate-400">
            {{ t('settings.observabilityConnection.incident.description') }}
          </p>

          <UFormField :label="t('settings.observabilityConnection.incident.pagerDutyToken')">
            <UInput v-model="pagerDuty.apiToken" type="password" class="w-full" />
          </UFormField>
          <UFormField :label="t('settings.observabilityConnection.incident.pagerDutyFromEmail')">
            <UInput
              v-model="pagerDuty.fromEmail"
              type="email"
              placeholder="oncall@example.com"
              class="w-full"
            />
          </UFormField>
          <UFormField :label="t('settings.observabilityConnection.incident.incidentIoKey')">
            <UInput v-model="incidentIo.apiKey" type="password" class="w-full" />
          </UFormField>

          <div class="flex gap-2">
            <UButton :loading="incidentBusy" @click="saveIncident">
              {{ t('common.save') }}
            </UButton>
            <UButton
              v-if="store.incident.connected"
              color="error"
              variant="soft"
              :loading="incidentBusy"
              @click="disconnectIncident"
            >
              {{ t('settings.observabilityConnection.incident.clear') }}
            </UButton>
          </div>
        </section>
      </div>
    </template>
  </UModal>
</template>
