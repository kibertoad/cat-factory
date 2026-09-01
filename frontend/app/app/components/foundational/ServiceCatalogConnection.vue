<script setup lang="ts">
// The workspace's SERVICE CATALOG connection: the developer portal (Backstage) whose services are
// imported into the foundational-services catalog as `workspace`-tier entries
// (backend/docs/service-catalog-import.md).
//
// A THIRD supply route beside the registry tab (upload) and the sources tab (a linked repo), so it
// lives beside them rather than in a settings page of its own: what it produces is the same
// catalog, and an operator deciding where a service came from should not have to look in two
// places.
//
// The form's shape follows the auth vocabulary, which is closed for a reason: these are the ways
// organisations actually run a self-hosted Backstage, and each needs a different request built. The
// fields shown switch on the selected mode, so a static token is one box and nothing else.
import { computed, reactive, ref } from 'vue'
import type { ConnectServiceCatalogInput, ServiceCatalogAuthMode } from '~/types/domain'
import { useFoundationalServicesStore } from '~/stores/foundationalServices'
import {
  SERVICE_CATALOG_AUTH_KEYS,
  SERVICE_CATALOG_AUTH_ORDER,
  SERVICE_CATALOG_STATUS_COLORS,
  serviceCatalogStatusKey,
} from '~/utils/serviceCatalog'

const catalog = useFoundationalServicesStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { t, d } = useI18n()
const { confirm } = useConfirm()

const authMode = ref<ServiceCatalogAuthMode>('static-token')
const form = reactive({
  baseUrl: '',
  token: '',
  sharedSecret: '',
  tokenUrl: '',
  clientId: '',
  clientSecret: '',
  scope: '',
  audience: '',
  username: '',
  password: '',
  headerName: '',
  headerValue: '',
  secondHeaderName: '',
  secondHeaderValue: '',
  entityFilter: '',
  includeApis: true,
  maxServices: 200,
})
const busy = ref<'connect' | 'probe' | 'import' | 'disconnect' | null>(null)

const connection = computed(() => catalog.serviceCatalog)

// Both vocabularies map to their keys in `~/utils/serviceCatalog`, whose spec asserts every entry
// against the base catalog: these are reached through a lookup rather than a literal `t('a.b.c')`,
// so the typed-message-key guard cannot see them.
const authModeItems = computed(() =>
  SERVICE_CATALOG_AUTH_ORDER.map((value) => ({
    value,
    label: t(SERVICE_CATALOG_AUTH_KEYS[value]),
  })),
)

const authModeLabel = (mode: ServiceCatalogAuthMode) => t(SERVICE_CATALOG_AUTH_KEYS[mode])
const statusLabel = computed(() =>
  t(serviceCatalogStatusKey(connection.value?.lastSyncStatus ?? null)),
)
const syncStatusColor = computed(() => {
  const status = connection.value?.lastSyncStatus
  return status ? SERVICE_CATALOG_STATUS_COLORS[status] : 'neutral'
})

/**
 * The body both `connect` and `probe` send.
 *
 * ONE builder for both, deliberately: the probe exists to test what the operator has just typed,
 * and a second builder is how a probe ends up testing a slightly different credential from the one
 * that gets stored.
 */
function buildInput(): ConnectServiceCatalogInput {
  const terms = form.entityFilter
    .split(/[\n,]/)
    .map((term) => term.trim())
    .filter(Boolean)
  return {
    baseUrl: form.baseUrl.trim(),
    auth: buildAuth(),
    ...(terms.length > 0 ? { entityFilter: terms } : {}),
    includeApis: form.includeApis,
    maxServices: form.maxServices,
  }
}

function buildAuth(): ConnectServiceCatalogInput['auth'] {
  switch (authMode.value) {
    case 'none':
      return { mode: 'none' }
    case 'static-token':
      return { mode: 'static-token', token: form.token.trim() }
    case 'legacy-shared-secret':
      return { mode: 'legacy-shared-secret', sharedSecret: form.sharedSecret.trim() }
    case 'oauth2-client-credentials':
      return {
        mode: 'oauth2-client-credentials',
        tokenUrl: form.tokenUrl.trim(),
        clientId: form.clientId.trim(),
        clientSecret: form.clientSecret.trim(),
        ...(form.scope.trim() ? { scope: form.scope.trim() } : {}),
        ...(form.audience.trim() ? { audience: form.audience.trim() } : {}),
      }
    case 'basic':
      return { mode: 'basic', username: form.username.trim(), password: form.password }
    case 'headers':
      return {
        mode: 'headers',
        headers: [
          { name: form.headerName.trim(), value: form.headerValue },
          ...(form.secondHeaderName.trim()
            ? [{ name: form.secondHeaderName.trim(), value: form.secondHeaderValue }]
            : []),
        ],
      }
  }
}

async function withBusy(kind: NonNullable<typeof busy.value>, fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = kind
  try {
    await fn()
  } finally {
    busy.value = null
  }
}

async function connect() {
  await withBusy('connect', async () => {
    try {
      await catalog.connectServiceCatalog(buildInput())
      toast.add({ title: t('serviceCatalog.toast.connected'), color: 'success' })
    } catch (error) {
      present(error, 'serviceCatalog.toast.connectFailed')
    }
  })
}

async function probe() {
  await withBusy('probe', async () => {
    try {
      const result = await catalog.probeServiceCatalog(buildInput())
      toast.add({
        title: result.ok
          ? t('serviceCatalog.toast.probeOk')
          : t('serviceCatalog.toast.probeFailed'),
        description: result.message,
        color: result.ok ? 'success' : 'error',
      })
    } catch (error) {
      present(error, 'serviceCatalog.toast.probeFailed')
    }
  })
}

async function importNow() {
  await withBusy('import', async () => {
    try {
      const result = await catalog.importServiceCatalog()
      toast.add({
        title: t('serviceCatalog.toast.imported'),
        description: t('serviceCatalog.toast.importedDetail', {
          upserted: result.upserted,
          unchanged: result.unchanged,
          tombstoned: result.tombstoned,
        }),
        color: result.status === 'ok' ? 'success' : 'warning',
      })
    } catch (error) {
      present(error, 'serviceCatalog.toast.importFailed')
    }
  })
}

async function disconnect() {
  // The imported services are TOMBSTONED with the connection, which is destructive enough to
  // confirm: an operator who expected the rows to stay would otherwise lose a board's whole
  // imported estate on one click.
  if (
    !(await confirm({
      title: t('serviceCatalog.disconnect.title'),
      description: t('serviceCatalog.disconnect.body'),
      confirmLabel: t('serviceCatalog.disconnect.confirm'),
      variant: 'destructive',
    }))
  ) {
    return
  }
  await withBusy('disconnect', async () => {
    try {
      await catalog.disconnectServiceCatalog()
      toast.add({ title: t('serviceCatalog.toast.disconnected'), color: 'success' })
    } catch (error) {
      present(error, 'serviceCatalog.toast.disconnectFailed')
    }
  })
}
</script>

<template>
  <div class="flex flex-col gap-4" data-testid="service-catalog-connection">
    <!-- Unwired is stated, never offered as a form that would fail with a raw 503. -->
    <div
      v-if="catalog.serviceCatalogAvailable === false"
      class="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-400"
    >
      {{ t('serviceCatalog.unavailable') }}
    </div>

    <template v-else>
      <p class="text-sm text-slate-400">{{ t('serviceCatalog.intro') }}</p>

      <!-- The CONNECTED state, with what the last import concluded. `lastSyncMessage` is the
           load-bearing line: it is what says a catalog is a PREFIX of the portal's estate. -->
      <div
        v-if="connection"
        class="flex flex-col gap-2 rounded-md border border-slate-800 bg-slate-900/40 p-3"
        data-testid="service-catalog-connected"
      >
        <div class="flex flex-wrap items-center gap-2">
          <UBadge :color="syncStatusColor" variant="subtle">{{ statusLabel }}</UBadge>
          <span class="font-mono text-xs text-slate-300">{{ connection.baseUrl }}</span>
          <span class="text-xs text-slate-500">{{ authModeLabel(connection.authMode) }}</span>
          <span v-if="connection.lastSyncedAt" class="text-xs text-slate-500">
            {{ d(new Date(connection.lastSyncedAt), 'short') }}
          </span>
        </div>
        <p class="text-xs text-slate-400">
          {{
            t('serviceCatalog.summary', {
              filter: connection.entityFilter.join(', '),
              max: connection.maxServices,
            })
          }}
        </p>
        <p v-if="connection.lastSyncMessage" class="text-xs text-amber-400">
          {{ connection.lastSyncMessage }}
        </p>
        <div class="flex gap-2">
          <UButton size="xs" :loading="busy === 'import'" :disabled="!!busy" @click="importNow">
            {{ t('serviceCatalog.action.import') }}
          </UButton>
          <UButton
            size="xs"
            color="error"
            variant="soft"
            :loading="busy === 'disconnect'"
            :disabled="!!busy"
            @click="disconnect"
          >
            {{ t('serviceCatalog.action.disconnect') }}
          </UButton>
        </div>
      </div>

      <!-- The connect / re-connect form. Shown alongside a live connection too, because rotating
           a token is the routine reason to come here. -->
      <div class="flex flex-col gap-3 rounded-md border border-slate-800 p-3">
        <h4 class="text-sm font-medium text-slate-200">
          {{ connection ? t('serviceCatalog.form.replace') : t('serviceCatalog.form.connect') }}
        </h4>

        <UFormField
          :label="t('serviceCatalog.field.baseUrl')"
          :help="t('serviceCatalog.help.baseUrl')"
        >
          <UInput v-model="form.baseUrl" placeholder="https://backstage.example.com" />
        </UFormField>

        <UFormField :label="t('serviceCatalog.field.authMode')">
          <USelect v-model="authMode" :items="authModeItems" value-key="value" />
        </UFormField>

        <UFormField
          v-if="authMode === 'static-token'"
          :label="t('serviceCatalog.field.token')"
          :help="t('serviceCatalog.help.token')"
        >
          <UInput v-model="form.token" type="password" />
        </UFormField>

        <UFormField
          v-if="authMode === 'legacy-shared-secret'"
          :label="t('serviceCatalog.field.sharedSecret')"
          :help="t('serviceCatalog.help.sharedSecret')"
        >
          <UInput v-model="form.sharedSecret" type="password" />
        </UFormField>

        <template v-if="authMode === 'oauth2-client-credentials'">
          <UFormField :label="t('serviceCatalog.field.tokenUrl')">
            <UInput v-model="form.tokenUrl" placeholder="https://idp.example.com/oauth2/token" />
          </UFormField>
          <UFormField :label="t('serviceCatalog.field.clientId')">
            <UInput v-model="form.clientId" />
          </UFormField>
          <UFormField :label="t('serviceCatalog.field.clientSecret')">
            <UInput v-model="form.clientSecret" type="password" />
          </UFormField>
          <UFormField :label="t('serviceCatalog.field.scope')">
            <UInput v-model="form.scope" />
          </UFormField>
          <UFormField :label="t('serviceCatalog.field.audience')">
            <UInput v-model="form.audience" />
          </UFormField>
        </template>

        <template v-if="authMode === 'basic'">
          <UFormField :label="t('serviceCatalog.field.username')">
            <UInput v-model="form.username" />
          </UFormField>
          <UFormField :label="t('serviceCatalog.field.password')">
            <UInput v-model="form.password" type="password" />
          </UFormField>
        </template>

        <template v-if="authMode === 'headers'">
          <UFormField
            :label="t('serviceCatalog.field.headerName')"
            :help="t('serviceCatalog.help.headers')"
          >
            <UInput v-model="form.headerName" placeholder="CF-Access-Client-Id" />
          </UFormField>
          <UFormField :label="t('serviceCatalog.field.headerValue')">
            <UInput v-model="form.headerValue" type="password" />
          </UFormField>
          <UFormField :label="t('serviceCatalog.field.secondHeaderName')">
            <UInput v-model="form.secondHeaderName" placeholder="CF-Access-Client-Secret" />
          </UFormField>
          <UFormField :label="t('serviceCatalog.field.secondHeaderValue')">
            <UInput v-model="form.secondHeaderValue" type="password" />
          </UFormField>
        </template>

        <UFormField
          :label="t('serviceCatalog.field.entityFilter')"
          :help="t('serviceCatalog.help.entityFilter')"
        >
          <UTextarea v-model="form.entityFilter" :rows="2" placeholder="kind=component" />
        </UFormField>

        <UFormField
          :label="t('serviceCatalog.field.maxServices')"
          :help="t('serviceCatalog.help.maxServices')"
        >
          <UInput v-model.number="form.maxServices" type="number" :min="1" :max="1000" />
        </UFormField>

        <UCheckbox v-model="form.includeApis" :label="t('serviceCatalog.field.includeApis')" />

        <div class="flex gap-2">
          <UButton
            size="xs"
            :loading="busy === 'connect'"
            :disabled="!!busy || !form.baseUrl.trim()"
            @click="connect"
          >
            {{
              connection ? t('serviceCatalog.action.replace') : t('serviceCatalog.action.connect')
            }}
          </UButton>
          <UButton
            size="xs"
            variant="soft"
            :loading="busy === 'probe'"
            :disabled="!!busy || !form.baseUrl.trim()"
            @click="probe"
          >
            {{ t('serviceCatalog.action.probe') }}
          </UButton>
        </div>
      </div>
    </template>
  </div>
</template>
