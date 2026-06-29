<script setup lang="ts">
// The single tabbed "Infrastructure" window — now a TOP-LEVEL navbar destination (no longer
// reached through the Integrations hub). Two topical tabs:
//   - "Agent containers" — where repo-operating agent containers run. Shows the execution
//     backend selector, the runner-pool connection (ProviderConnectionTab), and — in local
//     mode — the warm-container-pool + checkout-reuse settings (the local agent-container
//     runtime, folded in from the former LocalModeSettingsPanel).
//   - "Test environments" — where the Tester's ephemeral environments run. Shows the test-env
//     backend selector and the environment-provider connection.
// Local-specific affordances render inline, gated on `auth.localMode?.enabled`. A tab whose
// backend integration is disabled (503) simply doesn't render.
import { computed, ref, watch } from 'vue'
import type { ProviderConnectionKind } from '~/types/providerConnections'
import InfrastructureBackendPicker from '~/components/settings/InfrastructureBackendPicker.vue'
import LocalContainerPoolSettings from '~/components/settings/LocalContainerPoolSettings.vue'

const { t } = useI18n()
const ui = useUiStore()
const store = useProviderConnectionsStore()
const auth = useAuthStore()

const open = computed({
  get: () => ui.infrastructureOpen,
  set: (v: boolean) => {
    if (!v) ui.closeProviderConnection()
  },
})

const isLocal = computed(() => auth.localMode?.enabled === true)

// The tabs are driven by the deployment's infrastructure capability (every facade reports
// execution + test-env backends), NOT the optional provider-connection probes — the execution-
// backend selector must show even when no runner-pool / environment connection is registered.
// The connect form inside each tab still gates on its own probe (see the template).
const agentsAvailable = computed(() => (auth.infrastructure?.execution.available.length ?? 0) > 0)
const envsAvailable = computed(() => (auth.infrastructure?.testEnv.available.length ?? 0) > 0)

const tabs = computed(() => {
  const out: { value: ProviderConnectionKind; label: string; icon: string; slot: string }[] = []
  if (agentsAvailable.value)
    out.push({
      value: 'runner-pool',
      label: t('settings.providerConnection.tabs.agentContainers'),
      icon: 'i-lucide-server-cog',
      slot: 'runner-pool',
    })
  if (envsAvailable.value)
    out.push({
      value: 'environment',
      label: t('settings.providerConnection.tabs.testEnvironments'),
      icon: 'i-lucide-cloud',
      slot: 'environment',
    })
  return out
})

const activeTab = ref<ProviderConnectionKind>(ui.infrastructureTab)

// Honour the deep-linked tab each time the window opens, falling back to the first available
// tab if the requested one is off.
watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    void store.ensureLoaded().catch(() => {})
    const requested = ui.infrastructureTab
    const available = tabs.value.map((x) => x.value)
    activeTab.value = available.includes(requested) ? requested : (available[0] ?? requested)
  },
  { immediate: true },
)
// When availability resolves after open, re-pin onto a valid tab — but keep honouring the
// deep-linked request. The two availability probes resolve independently, so `tabs` can pass
// through a transient single-tab list; only fall back to the first tab once loading settled.
watch([tabs, () => store.loaded], () => {
  const list = tabs.value
  if (list.some((x) => x.value === activeTab.value)) return
  const requested = ui.infrastructureTab
  if (list.some((x) => x.value === requested)) {
    activeTab.value = requested
  } else if (store.loaded && list.length) {
    activeTab.value = list[0]!.value
  }
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('settings.providerConnection.windowTitle')"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <UTabs
          v-if="tabs.length"
          v-model="activeTab"
          :items="tabs"
          variant="link"
          :ui="{ root: 'gap-4' }"
          data-testid="infrastructure-tabs"
        >
          <template #runner-pool>
            <div class="space-y-4">
              <!-- One unified list of where agent containers run; the selected pool/cluster
                   reveals its connect form inline. -->
              <InfrastructureBackendPicker axis="execution" />
              <!-- Local mode: the warm-pool + checkout reuse ARE the host agent-container
                   runtime, so they live here rather than in a separate menu. -->
              <section v-if="isLocal" class="border-t border-slate-800 pt-4">
                <h3 class="mb-3 text-sm font-semibold text-slate-200">
                  {{ t('settings.localMode.title') }}
                </h3>
                <LocalContainerPoolSettings />
              </section>
            </div>
          </template>
          <template #environment>
            <div class="space-y-4">
              <!-- One unified list of where the Tester's ephemeral environments run. -->
              <InfrastructureBackendPicker axis="testEnv" />
            </div>
          </template>
        </UTabs>

        <p v-else class="px-1 py-6 text-center text-sm text-slate-500">
          {{ t('settings.providerConnection.noneAvailable') }}
        </p>
      </div>
    </template>
  </UModal>
</template>
