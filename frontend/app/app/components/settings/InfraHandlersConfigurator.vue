<script setup lang="ts">
// The per-provision-type infra configurator (the workspace + per-user "how"). One section per
// provision type a service can declare:
//   - kubernetes    → an engine picker (local-k3s / remote-kubernetes) revealing the kube
//                      ENGINE connect form (apiserver + URL derivation; the manifest SOURCE is
//                      service-owned, configured on the service).
//   - docker-compose → handled by the runtime's local Docker capability — informational, no
//                      connection (a DinD-capable runner stands the service's compose stack up).
//   - custom         → the custom-manifest-type catalog editor + a `remote-custom` HTTP handler
//                      per custom type (matched to a service's pinned `manifestId`).
// In LOCAL mode each handler additionally offers a per-USER override (this-machine only),
// written to the `/me/environment-handlers` endpoints. Drives the infraConfig store.
import { computed, ref, watch } from 'vue'
import type {
  CustomManifestType,
  EnvironmentHandlerView,
  InfraEngine,
} from '@cat-factory/contracts'
import KubernetesEngineForm from '~/components/settings/KubernetesEngineForm.vue'
import ProviderManifestEditor from '~/components/settings/ProviderManifestEditor.vue'
import CustomManifestTypeEditor from '~/components/settings/CustomManifestTypeEditor.vue'

const { t } = useI18n()
const infra = useInfraConfigStore()
const auth = useAuthStore()
const toast = useToast()

const isLocal = computed(() => auth.localMode?.enabled === true)

onMounted(() => {
  void infra.ensureLoaded()
  if (isLocal.value) void infra.loadUserHandlers()
})
watch(isLocal, (local) => {
  if (local) void infra.loadUserHandlers()
})

// The engines valid for the `kubernetes` provision type, mirroring the contract's discriminated
// `infraHandlerConfigSchema` (the engine list isn't served over HTTP). `local-k3s` is local-mode
// only; `remote-kubernetes` is always offered.
const kubeEngines = computed<Extract<InfraEngine, 'local-k3s' | 'remote-kubernetes'>[]>(() =>
  isLocal.value ? ['local-k3s', 'remote-kubernetes'] : ['remote-kubernetes'],
)
const KUBE_ENGINE_KEYS: Record<'local-k3s' | 'remote-kubernetes', string> = {
  'local-k3s': 'settings.infrastructure.engine.local-k3s',
  'remote-kubernetes': 'settings.infrastructure.engine.remote-kubernetes',
}

const kubeHandler = computed(() => infra.handlerFor('kubernetes') ?? null)
// The engine to configure: the registered handler's engine, else the first valid one.
const selectedKubeEngine = ref<'local-k3s' | 'remote-kubernetes'>('remote-kubernetes')
watch(
  [kubeHandler, kubeEngines],
  ([h, engines]) => {
    const e = h?.engine
    if (e === 'local-k3s' || e === 'remote-kubernetes') selectedKubeEngine.value = e
    else if (!engines.includes(selectedKubeEngine.value)) selectedKubeEngine.value = engines[0]!
  },
  { immediate: true },
)

const busy = ref(false)

async function saveKube(payload: {
  config: Record<string, unknown>
  secrets: Record<string, string>
}) {
  busy.value = true
  try {
    await infra.registerHandler({
      provisionType: 'kubernetes',
      config: payload.config as never,
      secrets: payload.secrets,
    })
    toastSaved()
  } catch (e) {
    notifyError(e)
  } finally {
    busy.value = false
  }
}

async function removeKube() {
  busy.value = true
  try {
    await infra.unregisterHandler('kubernetes')
    toastRemoved()
  } catch (e) {
    notifyError(e)
  } finally {
    busy.value = false
  }
}

// ---- per-user override (local mode only): a personal kube handler layered over the
// workspace one for THIS machine, written to the `/me/environment-handlers` endpoints. ----
const showKubeOverride = ref(false)
const kubeUserHandler = computed(() => infra.userHandlerFor('kubernetes') ?? null)
const userOverridesOn = computed(() => isLocal.value && infra.userOverridesAvailable === true)

async function saveKubeOverride(payload: {
  config: Record<string, unknown>
  secrets: Record<string, string>
}) {
  busy.value = true
  try {
    await infra.upsertUserHandler('kubernetes', {
      config: payload.config as never,
      secrets: payload.secrets,
    })
    toastSaved()
  } catch (e) {
    notifyError(e)
  } finally {
    busy.value = false
  }
}

async function removeKubeOverride() {
  busy.value = true
  try {
    await infra.removeUserHandler('kubernetes')
    toastRemoved()
  } catch (e) {
    notifyError(e)
  } finally {
    busy.value = false
  }
}

// ---- custom (remote-custom HTTP handler per custom-manifest-type) -----------
const selectedCustomId = ref<string>('')
const customTypeItems = computed(() =>
  infra.customTypes.map((c: CustomManifestType) => ({
    label: `${c.label} (${c.manifestId})`,
    value: c.manifestId,
  })),
)
watch(
  customTypeItems,
  (items) => {
    if (!items.some((i) => i.value === selectedCustomId.value)) {
      selectedCustomId.value = items[0]?.value ?? ''
    }
  },
  { immediate: true },
)
const customHandler = computed<EnvironmentHandlerView | null>(() =>
  selectedCustomId.value ? (infra.handlerFor('custom', selectedCustomId.value) ?? null) : null,
)
const customSavedManifest = computed<Record<string, unknown> | undefined>(() => {
  const cfg = customHandler.value?.config
  return cfg && cfg.engine === 'remote-custom'
    ? (cfg.manifest as Record<string, unknown>)
    : undefined
})

async function saveCustom(payload: {
  manifest: Record<string, unknown>
  secrets: Record<string, string>
}) {
  if (!selectedCustomId.value) return
  busy.value = true
  try {
    await infra.registerHandler({
      provisionType: 'custom',
      manifestId: selectedCustomId.value,
      config: {
        engine: 'remote-custom',
        manifest: payload.manifest,
        acceptsManifestId: selectedCustomId.value,
      } as never,
      secrets: payload.secrets,
    })
    toastSaved()
  } catch (e) {
    notifyError(e)
  } finally {
    busy.value = false
  }
}

async function removeCustom() {
  if (!selectedCustomId.value) return
  busy.value = true
  try {
    await infra.unregisterHandler('custom', selectedCustomId.value)
    toastRemoved()
  } catch (e) {
    notifyError(e)
  } finally {
    busy.value = false
  }
}

function toastSaved() {
  toast.add({
    title: t('settings.infrastructure.handler.saved'),
    icon: 'i-lucide-check',
    color: 'success',
  })
}
function toastRemoved() {
  toast.add({ title: t('settings.infrastructure.handler.removed'), icon: 'i-lucide-check' })
}
function notifyError(e: unknown) {
  toast.add({
    title: t('settings.infrastructure.handler.saveFailed'),
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}
</script>

<template>
  <div v-if="infra.available !== false" class="space-y-5">
    <p class="text-xs text-slate-400">{{ t('settings.infrastructure.handler.intro') }}</p>

    <!-- kubernetes -->
    <section class="space-y-2 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <h3 class="text-sm font-semibold text-slate-200">
        {{ t('inspector.testConfig.provisionTypes.kubernetes') }}
      </h3>
      <p
        v-if="kubeHandler"
        class="flex items-center justify-between gap-2 text-[12px] text-slate-300"
      >
        <span>
          {{ t('settings.infrastructure.handler.activeEngine') }}
          <span class="text-slate-200">{{ t(KUBE_ENGINE_KEYS[selectedKubeEngine]) }}</span>
        </span>
        <UButton
          icon="i-lucide-trash-2"
          color="error"
          variant="ghost"
          size="xs"
          :disabled="busy"
          @click="removeKube"
        />
      </p>

      <div class="space-y-1">
        <span class="text-[11px] text-slate-400">{{
          t('settings.infrastructure.handler.engineLabel')
        }}</span>
        <div class="flex flex-wrap gap-1">
          <UButton
            v-for="e in kubeEngines"
            :key="e"
            :color="selectedKubeEngine === e ? 'primary' : 'neutral'"
            :variant="selectedKubeEngine === e ? 'soft' : 'ghost'"
            size="xs"
            @click="selectedKubeEngine = e"
          >
            {{ t(KUBE_ENGINE_KEYS[e]) }}
          </UButton>
        </div>
      </div>

      <KubernetesEngineForm
        :engine="selectedKubeEngine"
        :handler="kubeHandler"
        :supports-test="false"
        :testing="false"
        :busy="busy"
        :test-result="null"
        @save="saveKube"
      />

      <!-- Local mode: a personal override for THIS machine, layered over the workspace handler. -->
      <div v-if="userOverridesOn" class="border-t border-slate-800 pt-2">
        <button
          type="button"
          class="flex w-full items-center gap-1.5 text-start text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-300"
          @click="showKubeOverride = !showKubeOverride"
        >
          <UIcon
            :name="showKubeOverride ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            class="h-3.5 w-3.5"
          />
          {{ t('settings.infrastructure.handler.personalOverride') }}
          <UBadge v-if="kubeUserHandler" color="primary" variant="subtle" size="sm">
            {{ t('settings.infrastructure.handler.overrideActive') }}
          </UBadge>
        </button>
        <div v-if="showKubeOverride" class="mt-2 space-y-2">
          <p class="text-[11px] text-slate-500">
            {{ t('settings.infrastructure.handler.personalOverrideHint') }}
          </p>
          <p v-if="kubeUserHandler" class="flex justify-end">
            <UButton
              icon="i-lucide-trash-2"
              color="error"
              variant="ghost"
              size="xs"
              :disabled="busy"
              @click="removeKubeOverride"
            >
              {{ t('settings.infrastructure.handler.removeOverride') }}
            </UButton>
          </p>
          <KubernetesEngineForm
            :engine="selectedKubeEngine"
            :handler="kubeUserHandler"
            :supports-test="false"
            :testing="false"
            :busy="busy"
            :test-result="null"
            @save="saveKubeOverride"
          />
        </div>
      </div>
    </section>

    <!-- docker-compose: handled by the runtime's local Docker capability, no connection. -->
    <section class="space-y-1 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <h3 class="text-sm font-semibold text-slate-200">
        {{ t('inspector.testConfig.provisionTypes.docker-compose') }}
      </h3>
      <p class="text-[12px] text-slate-400">{{ t('settings.infrastructure.dockerComposeInfo') }}</p>
    </section>

    <!-- custom: the catalog editor + a remote-custom HTTP handler per custom type. -->
    <section class="space-y-3 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
      <h3 class="text-sm font-semibold text-slate-200">
        {{ t('inspector.testConfig.provisionTypes.custom') }}
      </h3>

      <CustomManifestTypeEditor />

      <div v-if="infra.customTypes.length" class="space-y-2 border-t border-slate-800 pt-3">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('settings.infrastructure.handler.customHandlerTitle') }}
        </p>
        <UFormField :label="t('settings.infrastructure.handler.customTypeLabel')">
          <USelect v-model="selectedCustomId" :items="customTypeItems" />
        </UFormField>
        <p
          v-if="customHandler"
          class="flex items-center justify-between gap-2 text-[12px] text-slate-300"
        >
          <span class="text-emerald-400">{{
            t('settings.infrastructure.handler.customConnected')
          }}</span>
          <UButton
            icon="i-lucide-trash-2"
            color="error"
            variant="ghost"
            size="xs"
            :disabled="busy"
            @click="removeCustom"
          />
        </p>
        <ProviderManifestEditor
          v-if="selectedCustomId"
          :key="selectedCustomId"
          kind="environment"
          :saved-manifest="customSavedManifest"
          :connected="!!customHandler"
          :stored-secret-keys="customHandler?.secretKeys ?? []"
          :supports-test="false"
          :testing="false"
          :busy="busy"
          :test-result="null"
          @save="saveCustom"
        />
      </div>
    </section>
  </div>
</template>
